/**
 * Redis Games Broadcast - re-exports from redis-cluster-broadcast for backward compatibility
 */
export {
  initRedisClusterBroadcast as initRedisGamesBroadcast,
  subscribeToGamesBroadcast,
  publishGamesBroadcast,
  isRedisGamesBroadcastReady,
  type GamesBroadcastMessage,
} from './redis-cluster-broadcast.service';

export { shutdownRedisClusterBroadcast as shutdownRedisGamesBroadcast } from './redis-cluster-broadcast.service';
