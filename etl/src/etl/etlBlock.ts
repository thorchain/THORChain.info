import { execFile } from 'child_process'
import { promisify } from 'util'
import { cache } from '../cache/cache'
import { calcBase64ByteSize } from '../helpers/calcBase64ByteSize'
import { env } from '../helpers/env'
import { http } from '../helpers/http'
import { IStoredBlock, IStoredRecentTx } from '../interfaces/stored'
import { IRpcBlock, IRpcBlockResults } from '../interfaces/tendermintRpc'
import { ILcdDecodedTx } from '../interfaces/thorchainLcd'
import { ElasticSearchService } from '../services/ElasticSearch'
import { EtlService } from '../services/EtlService'
import { logger } from '../services/logger'
import { ParallelPromiseLimiter } from '../services/ParallelPromiseLimiter'
import { extractBlockResults, transformBlockResults } from './etlBlockResults'

const promisedExecFile = promisify(execFile)

export async function etlBlock (etlService: EtlService, esService: ElasticSearchService, wantendHeight: number | null) {
  logger.debug('Will etl block ' + wantendHeight)
  const extracted = await extract(wantendHeight)
  const height = parseInt(extracted.header.height, 10)

  if (height === cache.latestBlockHeight) {
    // we have already seen that block - no need to transform or process it again
    return height
  }

  const transformed = await transform(extracted, height)
  await load(etlService, esService, transformed)

  return height
}

async function extract (height: number | null): Promise<IRpcBlock> {
  const { result }: { result: { block: IRpcBlock } } =
    await http.get(env.TENDERMINT_RPC_REST + `/block` + (height ? `?height=${height}` : ''))

  return result.block
}

export async function transform (block: IRpcBlock, height: number): Promise<ITransformedBlock> {
  const result: ITransformedBlock = {
    addresses: new Set<string>(),
    block: {
      amountTransacted: 0,
      amountTransactedClp: 0,
      height,
      numClpTxs: 0,
      numTxs: parseInt(block.header.num_txs, 10),
      size: block.data.txs ? block.data.txs.map(calcBase64ByteSize).reduce((sum, size) => sum + size, 0) : 0,
      time: block.header.time,
    },
    recentTxs: [],
  }

  const blockCache: ITransformCache =
    { blockResultsPromise: null, blockResults: null, amountTransacted: new Map<string, number>() }

  if (block.data.txs) {
    const limiter = new ParallelPromiseLimiter(100)

    for (let i = 0; i < block.data.txs.length; i++) {
      await limiter.push(() => transformTx(result, blockCache)(block.data.txs![i], i))
    }
  }

  // convert and add other currencies than RUNE of amountTransacted map to block
  for (const [denom, amount] of blockCache.amountTransacted) {
    if (denom === 'RUNE') {
      result.block.amountTransacted += amount
      continue
    }
    // TODO get current exchange rate
    // await http.get(env.TENDERMINT_RPC_REST + `/clp/${denom}?height=${result.block.height}`)
  }

  return result
}

export async function load(etlService: EtlService, esService: ElasticSearchService, trans: ITransformedBlock) {
  const bulkBody: any[] = []

  bulkBody.push({ index: { _index: 'blocks', _type: 'type', _id: `${trans.block.height}` } })
  bulkBody.push(trans.block)

  trans.addresses.forEach(address => {
    bulkBody.push({ index: { _index: 'addresses', _type: 'type', _id: address } })
    bulkBody.push({})
  })

  let index = 0
  trans.recentTxs.forEach(recentTxsInMsgs => recentTxsInMsgs.forEach(recentTx => {
    recentTx.index = index
    index++
    bulkBody.push({ index: { _index: 'recent-txs', _type: 'type' } })
    bulkBody.push(recentTx)
  }))

  await esService.bulk({ body: bulkBody })
}

const transformTx = (result: ITransformedBlock, blockCache: ITransformCache) =>
  async (tx: string, index: number): Promise<void> => {

  // put recentTxs into result first, so order is maintained
  const recentTxs: IStoredRecentTx[] = []
  result.recentTxs.push(recentTxs)

  let decodedTx: string
  try {
    let stderr
    ({ stdout: decodedTx, stderr } = await promisedExecFile('thorchaindebug', ['tx', tx]))
    if (stderr) {
      throw new Error(`Cound not decode tx ${index} in block ${result.block.height}: ${tx}, got error: ${stderr}`)
    }
  } catch (e) {
    throw new Error(`Cound not decode tx ${index} in block ${result.block.height}: ${tx}, got error: ${e}`)
  }

  let parsedTx: ILcdDecodedTx
  try {
    parsedTx = JSON.parse(decodedTx)
  } catch (e) {
    throw new Error(`Cound not parse tx ${index} in block ${result.block.height}: "${decodedTx}", got error: ${e}`)
  }

  if (parsedTx.type === 'auth/StdTx') {
    for (const msg of parsedTx.value.msg) {
      if (msg.type === 'cosmos-sdk/Send') {
        // input coins are enough for total transacted, output must match input
        msg.value.inputs.forEach(i => {
          i.coins.forEach(c => blockCache.amountTransacted[c.denom] += Number(c.amount))
        })
        // output addresses is enough, every address needs to have been the output of another before
        msg.value.outputs.forEach(o => result.addresses.add(o.address))

        // TODO split up for M:N txs each with different coins, right now these are ignored
        const inputs = msg.value.inputs
        const outputs = msg.value.outputs
        if (msg.value.inputs.length !== 1 || msg.value.outputs.length !== 1) { continue }
        if (inputs[0].coins.length !== 1 || outputs[0].coins.length !== 1) { continue }
        recentTxs.push({
          from: inputs[0].address,
          from_coins: inputs[0].coins[0],
          height: result.block.height,
          time: result.block.time,
          to: outputs[0].address,
          to_coins: outputs[0].coins[0],
          type: 'Tx',
        } as IStoredRecentTx)
      } else if (msg.type === 'clp/MsgTrade') {
        result.block.numClpTxs++

        // get to amount and rune transacted
        if (blockCache.blockResultsPromise === null) {
          blockCache.blockResultsPromise = extractBlockResults(result.block.height)
        }

        try {
          blockCache.blockResults = await blockCache.blockResultsPromise
        } catch (e) {
          logger.error(`Could not receive block results for block ${result.block.height}, error:`, e)
        }

        if (blockCache.blockResults === null) { continue }

        try {
          const transformedBlockResults = await transformBlockResults(result, blockCache.blockResults!, index)

          result.block.amountTransactedClp += transformedBlockResults.runeTransacted

          recentTxs.push({
            from: msg.value.Sender,
            from_coins: { amount: msg.value.FromAmount, denom: msg.value.FromTicker },
            height: result.block.height,
            time: result.block.time,
            to: msg.value.Sender,
            to_coins: { amount: `${transformedBlockResults.toTokenReceived}`, denom: msg.value.ToTicker },
            type: 'CLP',
          } as IStoredRecentTx)
        } catch (e) {
          // TODO remove try/catch block as soon as the following issue is resolved:
          // https://github.com/thorchain/THORChain/issues/29
        }
      }
    }
  }
}

interface ITransformCache {
  blockResultsPromise: null | Promise<IRpcBlockResults>,
  blockResults: null | IRpcBlockResults,
  amountTransacted: Map<string, number>,
}

export interface ITransformedBlock {
  addresses: Set<string>
  block: IStoredBlock
  recentTxs: IStoredRecentTx[][]
}
