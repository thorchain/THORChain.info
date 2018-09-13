import { IRecentTxMetrics } from '../interfaces/metrics'
import { getRecentTxs } from '../query/getRecentTxs'
import { ElasticSearchService } from '../services/ElasticSearch'

export async function getRecentTxsMetrics(esService: ElasticSearchService, size: number):
  Promise<IRecentTxMetrics[]> {
  return await getRecentTxs(esService, size)
}