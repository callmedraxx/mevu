/**
 * Data transformation and event grouping logic
 * Groups markets by events and standardizes field names
 */

import { logger } from '../../config/logger';
import { TransformationError, ErrorCode } from '../../utils/errors';
import {
  PolymarketEvent,
  PolymarketMarket,
  TransformedEvent,
  TransformedMarket,
  TransformedOutcome,
  TransformedTag,
} from './polymarket.types';

/**
 * Parse outcome prices from string array or JSON string
 * Polymarket returns prices as decimals (0.01 = 1%, 0.84 = 84%)
 * We need to multiply by 100 to convert to percentage
 */
function parseOutcomePrices(prices: string[] | string | undefined): number[] {
  if (!prices) {
    return [];
  }

  try {
    // Handle case where prices is a single JSON string
    if (typeof prices === 'string') {
      try {
        const parsed = JSON.parse(prices);
        if (Array.isArray(parsed)) {
          return parsed.map((p) => {
            const num = typeof p === 'string' ? parseFloat(p) : p;
            if (isNaN(num)) return 0;
            // Multiply by 100 to convert from decimal (0.01) to percentage (1)
            const percentage = num * 100;
            return Math.max(0, Math.min(100, percentage));
          });
        }
      } catch {
        // Not JSON, try parsing as single number
        const num = parseFloat(prices);
        if (!isNaN(num)) {
          const percentage = num * 100;
          return [Math.max(0, Math.min(100, percentage))];
        }
      }
      return [];
    }

    // Handle array case
    if (Array.isArray(prices)) {
      // Handle JSON string arrays (single element that's a JSON string)
      if (prices.length === 1 && typeof prices[0] === 'string') {
        try {
          const parsed = JSON.parse(prices[0]);
          if (Array.isArray(parsed)) {
            return parsed.map((p) => {
              const num = typeof p === 'string' ? parseFloat(p) : p;
              if (isNaN(num)) return 0;
              // Multiply by 100 to convert from decimal (0.01) to percentage (1)
              const percentage = num * 100;
              return Math.max(0, Math.min(100, percentage));
            });
          }
        } catch {
          // Not JSON, continue with normal parsing
        }
      }

      return prices.map((p) => {
        const num = typeof p === 'string' ? parseFloat(p) : p;
        if (isNaN(num)) return 0;
        // Multiply by 100 to convert from decimal (0.01) to percentage (1)
        const percentage = num * 100;
        return Math.max(0, Math.min(100, percentage));
      });
    }

    return [];
  } catch (error) {
    logger.warn({
      message: 'Error parsing outcome prices',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Parse outcomes from string array
 */
function parseOutcomes(outcomes: string[] | undefined): string[] {
  if (!outcomes || !Array.isArray(outcomes)) {
    return [];
  }

  try {
    // Handle JSON string arrays
    if (outcomes.length === 1 && typeof outcomes[0] === 'string') {
      try {
        const parsed = JSON.parse(outcomes[0]);
        if (Array.isArray(parsed)) {
          return parsed.map((o) => String(o));
        }
      } catch {
        // Not JSON, continue with normal parsing
      }
    }

    return outcomes.map((o) => String(o));
  } catch (error) {
    logger.warn({
      message: 'Error parsing outcomes',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Extract clobTokenIds from various formats
 */
function extractClobTokenIds(clobTokenIds: string[] | string | undefined): string[] {
  if (!clobTokenIds) {
    return [];
  }

  if (Array.isArray(clobTokenIds)) {
    return clobTokenIds.map((id) => String(id)).filter((id) => id.length > 0);
  }

  if (typeof clobTokenIds === 'string') {
    try {
      // Try to parse as JSON
      const sanitized = clobTokenIds.trim().replace(/'/g, '"');
      const parsed = JSON.parse(sanitized);
      if (Array.isArray(parsed)) {
        return parsed.map((id) => String(id)).filter((id) => id.length > 0);
      }
    } catch {
      // If JSON parsing fails, try regex extraction
      const match = clobTokenIds.match(/\d{70,}/g);
      if (match) {
        return match;
      }
    }
  }

  return [];
}

/**
 * Create structured outcomes from a market
 */
function createTransformedOutcomes(market: PolymarketMarket): TransformedOutcome[] {
  const outcomeLabels = parseOutcomes(market.outcomes);
  const prices = parseOutcomePrices(market.outcomePrices);
  const tokenIds = extractClobTokenIds(market.clobTokenIds);

  if (outcomeLabels.length === 0) {
    return [];
  }

  const marketVolume = typeof market.volume === 'string'
    ? parseFloat(market.volume)
    : (market.volumeNum || market.volume || 0);

  // Calculate individual outcome volumes (distribute market volume proportionally)
  const totalPrice = prices.reduce((sum, p) => sum + p, 0);
  const volumePerOutcome = totalPrice > 0
    ? outcomeLabels.map((_, index) => {
        const priceRatio = prices[index] || 0;
        return (priceRatio / totalPrice) * marketVolume;
      })
    : outcomeLabels.map(() => marketVolume / outcomeLabels.length);

  // Detect if market is resolved (closed and has a winner)
  const isResolved = market.closed === true;
  // Find winner: In a resolved binary market, the winner is the outcome with the highest price
  // Prices are already in percentage form (0-100) after parseOutcomePrices
  // For resolved markets, find the index with the maximum price (either Yes or No can win)
  let winnerIndex = -1;
  if (isResolved && prices.length > 0) {
    let maxPrice = -1;
    prices.forEach((p, index) => {
      const priceNum = typeof p === 'string' ? parseFloat(p) : p;
      if (!isNaN(priceNum) && priceNum > maxPrice) {
        maxPrice = priceNum;
        winnerIndex = index;
      }
    });
    // Only consider it a winner if price is >= 99 (very high confidence)
    if (maxPrice < 99) {
      winnerIndex = -1; // No clear winner if max price is too low
    }
  }

  return outcomeLabels.map((label, index) => {
    const rawPrice = prices[index] || 0;
    const probability = Math.max(0, Math.min(100, Math.round(rawPrice)));
    const priceInCents = rawPrice.toFixed(2);
    const isWinner = isResolved && index === winnerIndex;

    return {
      label: label || 'Unknown',
      shortLabel: (label || 'UNK').slice(0, 3).toUpperCase(),
      price: priceInCents,
      probability: probability,
      volume: Math.round(volumePerOutcome[index] || 0),
      icon: market.icon,
      clobTokenId: tokenIds[index],
      conditionId: market.conditionId,
      isWinner: isWinner || undefined, // Only set if true
    };
  });
}

/**
 * Transform a single market
 */
function transformMarket(market: PolymarketMarket): TransformedMarket {
  try {
    const volume = typeof market.volume === 'string' 
      ? parseFloat(market.volume) 
      : (market.volumeNum || market.volume || 0);

    const liquidity = typeof market.liquidity === 'string'
      ? parseFloat(market.liquidity)
      : (market.liquidityNum || market.liquidityClob || 0);

    // Create structured outcomes
    const structuredOutcomes = createTransformedOutcomes(market);

    // Detect if this is a group item
    const isGroupItem = !!market.groupItemTitle;

    // Extract and store clobTokenIds
    const clobTokenIds = extractClobTokenIds(market.clobTokenIds);

    // Parse raw outcomes and prices for backward compatibility
    let rawOutcomes: string[] | undefined;
    let rawOutcomePrices: string[] | undefined;
    try {
      rawOutcomes = market.outcomes ? JSON.parse(String(market.outcomes)) : undefined;
      rawOutcomePrices = market.outcomePrices ? JSON.parse(String(market.outcomePrices)) : undefined;
    } catch {
      // If parsing fails, use as-is
      rawOutcomes = market.outcomes;
      rawOutcomePrices = market.outcomePrices;
    }

    return {
      id: market.id,
      question: market.question || '',
      slug: market.slug,
      conditionId: market.conditionId,
      volume: volume,
      volume24Hr: market.volume24hr,
      volume1Wk: market.volume1wk,
      volume1Mo: market.volume1mo,
      volume1Yr: market.volume1yr,
      active: market.active ?? false,
      closed: market.closed ?? false,
      archived: market.archived ?? false,
      image: market.image,
      icon: market.icon,
      description: market.description,
      outcomes: rawOutcomes, // Deprecated: kept for backward compatibility
      outcomePrices: rawOutcomePrices, // Deprecated: kept for backward compatibility
      structuredOutcomes: structuredOutcomes,
      isGroupItem: isGroupItem,
      groupItemTitle: market.groupItemTitle,
      groupItemThreshold: market.groupItemThreshold,
      clobTokenIds: clobTokenIds,
      endDate: market.endDate || market.endDateIso,
      startDate: market.startDate || market.startDateIso,
      lastTradePrice: market.lastTradePrice,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      spread: market.spread,
      competitive: market.competitive,
      liquidity: liquidity,
      createdAt: market.createdAt,
      updatedAt: market.updatedAt,
      // Resolution fields (for resolved markets)
      closedTime: market.closedTime,
      resolvedBy: market.resolvedBy,
      resolutionSource: market.resolutionSource,
      umaResolutionStatus: market.umaResolutionStatus,
      automaticallyResolved: market.automaticallyResolved,
      // Trading fields
      negRisk: market.negRisk,
      negRiskMarketId: market.negRiskMarketID,
    };
  } catch (error) {
    logger.error({
      message: 'Error transforming market',
      marketId: market.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new TransformationError(
      ErrorCode.DATA_PARSING_ERROR,
      `Failed to transform market ${market.id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Transform tags
 */
function transformTags(tags?: any[]): TransformedTag[] {
  if (!tags || !Array.isArray(tags)) {
    return [];
  }

  return tags.map((tag) => ({
    id: String(tag.id || ''),
    label: tag.label || '',
    slug: tag.slug || '',
  })).filter((tag) => tag.id && tag.label && tag.slug);
}

/**
 * Transform a single event and group its markets
 */
function transformEvent(event: PolymarketEvent): TransformedEvent {
  try {
    // Transform markets
    // Include closed markets for resolved events (they may have resolution data)
    const markets: TransformedMarket[] = (event.markets || [])
      .filter((market) => {
        // Filter out invalid/archived markets
        if (market.archived) return false;
        // Keep active markets and closed markets (for resolved events)
        return market.active || market.closed;
      })
      .map((market) => transformMarket(market));

    // Calculate total volumes
    const totalVolume = markets.reduce((sum, market) => sum + (market.volume || 0), 0);
    const totalVolume24Hr = markets.reduce((sum, market) => sum + (market.volume24Hr || 0), 0);
    const totalVolume1Wk = markets.reduce((sum, market) => sum + (market.volume1Wk || 0), 0);
    const totalVolume1Mo = markets.reduce((sum, market) => sum + (market.volume1Mo || 0), 0);
    const totalVolume1Yr = markets.reduce((sum, market) => sum + (market.volume1Yr || 0), 0);

    // Calculate total liquidity
    const totalLiquidity = markets.reduce((sum, market) => sum + (market.liquidity || 0), 0);

    // Get event-level competitive score (average of markets or event-level)
    const competitive = event.competitive ?? 
      (markets.length > 0 
        ? markets.reduce((sum, m) => sum + (m.competitive || 0), 0) / markets.length 
        : 0);

    const eventVolume = typeof event.volume === 'string'
      ? parseFloat(event.volume)
      : (typeof event.volume === 'number' ? event.volume : 0);

    const eventLiquidity = typeof event.liquidity === 'string'
      ? parseFloat(event.liquidity)
      : (typeof event.liquidity === 'number' ? event.liquidity : 0);

    // Detect if event has group items
    const hasGroupItems = markets.some((m) => m.isGroupItem);

    // Create groupedOutcomes based on whether we have group items
    let groupedOutcomes: TransformedOutcome[] | undefined;

    if (hasGroupItems) {
      // Filter and sort group item markets by threshold
      // Include closed markets for resolved events
      const groupMarkets = markets
        .filter((m) => m.isGroupItem && !m.archived && (m.active || m.closed))
        .sort((a, b) => {
          const aThreshold = parseFloat(a.groupItemThreshold || '0');
          const bThreshold = parseFloat(b.groupItemThreshold || '0');
          return aThreshold - bThreshold;
        });

      if (groupMarkets.length > 0) {
        // Aggregate outcomes from all group items
        const aggregatedOutcomes: TransformedOutcome[] = [];

        for (const groupMarket of groupMarkets) {
          // For group items, each market represents one outcome
          // Use structuredOutcomes if available (already has correct probabilities)
          // Otherwise, parse outcomePrices directly
          let outcome: TransformedOutcome;
          
          if (groupMarket.structuredOutcomes && groupMarket.structuredOutcomes.length > 0) {
            // Use the first structured outcome (group items typically have one outcome)
            const structured = groupMarket.structuredOutcomes[0];
            outcome = {
              ...structured,
              label: groupMarket.groupItemTitle || structured.label,
              shortLabel: (groupMarket.groupItemTitle || structured.label).slice(0, 3).toUpperCase(),
              volume: groupMarket.volume || structured.volume,
              icon: groupMarket.icon || structured.icon,
              groupItemThreshold: groupMarket.groupItemThreshold,
              // Preserve isWinner flag if market is resolved
              isWinner: structured.isWinner,
            };
          } else {
            // Fallback: parse outcomePrices directly
            const prices = parseOutcomePrices(groupMarket.outcomePrices);
            const yesPrice = prices[0] || 0;
            const probability = Math.max(0, Math.min(100, Math.round(yesPrice)));
            
            // Detect if this group market is resolved and won
            // yesPrice is already in percentage form (0-100) after parseOutcomePrices
            // For group markets, check if yesPrice is the highest (>= 99 indicates winner)
            const isResolved = groupMarket.closed === true;
            const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
            const isWinner = isResolved && yesPrice >= 99 && yesPrice === maxPrice;
            
            // Extract clobTokenId from stored clobTokenIds
            const clobTokenId = groupMarket.clobTokenIds?.[0] || undefined;

            outcome = {
              label: groupMarket.groupItemTitle || groupMarket.question || 'Unknown',
              shortLabel: (groupMarket.groupItemTitle || groupMarket.question || 'UNK').slice(0, 3).toUpperCase(),
              price: yesPrice.toFixed(2),
              probability: probability,
              volume: groupMarket.volume || 0,
              icon: groupMarket.icon,
              clobTokenId: clobTokenId,
              conditionId: groupMarket.conditionId,
              groupItemThreshold: groupMarket.groupItemThreshold,
              isWinner: isWinner || undefined, // Only set if true
            };
          }

          aggregatedOutcomes.push(outcome);
        }

        // Sort by probability descending
        groupedOutcomes = aggregatedOutcomes.sort((a, b) => b.probability - a.probability);
      }
    } else {
      // For non-group items, use the best market by liquidity (or volume)
      // If the best market has no outcomes, try other markets as fallback
      // Include closed markets for resolved events
      const activeMarkets = markets.filter((m) => !m.archived && (m.active || m.closed));

      if (activeMarkets.length > 0) {
        // Sort markets by liquidity (then volume) to prioritize best markets
        const sortedMarkets = [...activeMarkets].sort((a, b) => {
          const aLiquidity = a.liquidity || 0;
          const bLiquidity = b.liquidity || 0;
          if (aLiquidity !== bLiquidity) {
            return bLiquidity - aLiquidity;
          }
          return (b.volume || 0) - (a.volume || 0);
        });

        // Try markets in order until we find one with outcomes
        for (const market of sortedMarkets) {
          if (market.structuredOutcomes && market.structuredOutcomes.length > 0) {
            groupedOutcomes = [...market.structuredOutcomes].sort((a, b) => b.probability - a.probability);
            break;
          }
        }

        // If still no outcomes found, try to create outcomes from raw data as fallback
        if (!groupedOutcomes || groupedOutcomes.length === 0) {
          for (const market of sortedMarkets) {
            // Try to parse outcomes directly from raw market data
            const outcomeLabels = parseOutcomes(market.outcomes);
            const prices = parseOutcomePrices(market.outcomePrices);
            
            if (outcomeLabels.length > 0 && prices.length > 0) {
              const tokenIds = market.clobTokenIds || [];
              const marketVolume = market.volume || 0;
              
              // Calculate individual outcome volumes (distribute market volume proportionally)
              const totalPrice = prices.reduce((sum, p) => sum + p, 0);
              const volumePerOutcome = totalPrice > 0
                ? outcomeLabels.map((_, index) => {
                    const priceRatio = prices[index] || 0;
                    return (priceRatio / totalPrice) * marketVolume;
                  })
                : outcomeLabels.map(() => marketVolume / outcomeLabels.length);
              
              // Detect if market is resolved and find winner
              const isResolved = market.closed === true;
              let winnerIndex = -1;
              if (isResolved && prices.length > 0) {
                let maxPrice = -1;
                prices.forEach((p, index) => {
                  const priceNum = typeof p === 'string' ? parseFloat(p) : p;
                  if (!isNaN(priceNum) && priceNum > maxPrice) {
                    maxPrice = priceNum;
                    winnerIndex = index;
                  }
                });
                // Only consider it a winner if price is >= 99 (very high confidence)
                if (maxPrice < 99) {
                  winnerIndex = -1; // No clear winner if max price is too low
                }
              }
              
              groupedOutcomes = outcomeLabels.map((label, index) => {
                const rawPrice = prices[index] || 0;
                const probability = Math.max(0, Math.min(100, Math.round(rawPrice)));
                const isWinner = isResolved && index === winnerIndex;
                
                return {
                  label: label || 'Unknown',
                  shortLabel: (label || 'UNK').slice(0, 3).toUpperCase(),
                  price: rawPrice.toFixed(2),
                  probability: probability,
                  volume: Math.round(volumePerOutcome[index] || 0),
                  icon: market.icon,
                  clobTokenId: tokenIds[index],
                  conditionId: market.conditionId,
                  isWinner: isWinner || undefined, // Only set if true
                };
              }).sort((a, b) => b.probability - a.probability);
              
              if (groupedOutcomes.length > 0) {
                logger.info({
                  message: 'Created fallback outcomes from raw market data',
                  eventId: event.id,
                  marketId: market.id,
                  outcomeCount: groupedOutcomes.length,
                });
                break;
              }
            }
          }
        }
      }
    }

    // Determine if event is resolved
    const isResolved = event.closed === true || 
      (markets.length > 0 && markets.every((m) => m.closed || !m.active));

    // For single binary resolved markets, filter to show only winner
    // Grouped events should show all outcomes (winners and losers)
    if (groupedOutcomes && groupedOutcomes.length > 0 && isResolved && !hasGroupItems) {
      // Check if this is a binary market (exactly 2 outcomes with Yes/No)
      const isBinaryMarket = groupedOutcomes.length === 2 &&
        groupedOutcomes.some(o => o.label.toLowerCase() === 'yes') &&
        groupedOutcomes.some(o => o.label.toLowerCase() === 'no');
      
      // Check if we have a winner detected
      const hasWinner = groupedOutcomes.some(o => o.isWinner === true);
      
      if (isBinaryMarket && hasWinner) {
        // Only keep the winner for single binary markets (only if winner is detected)
        groupedOutcomes = groupedOutcomes.filter(o => o.isWinner === true);
      }
      // For non-binary single markets or grouped events, or if no winner detected, keep all outcomes
    }

    return {
      id: event.id,
      title: event.title || '',
      slug: event.slug || '',
      description: event.description,
      image: event.image || event.icon,
      icon: event.icon || event.image,
      totalVolume: eventVolume || totalVolume,
      volume24Hr: event.volume24hr || totalVolume24Hr,
      volume1Wk: event.volume1wk || totalVolume1Wk,
      volume1Mo: event.volume1mo || totalVolume1Mo,
      volume1Yr: event.volume1yr || totalVolume1Yr,
      liquidity: eventLiquidity || totalLiquidity || event.liquidityClob,
      openInterest: event.openInterest,
      competitive: competitive,
      active: event.active ?? false,
      closed: event.closed ?? false,
      archived: event.archived ?? false,
      restricted: event.restricted,
      featured: event.featured,
      commentCount: event.commentCount,
      markets: markets.sort((a, b) => (b.volume || 0) - (a.volume || 0)), // Sort markets by volume descending
      tags: transformTags(event.tags),
      startDate: event.startDate || event.startTime,
      endDate: event.endDate,
      createdAt: event.createdAt || event.creationDate,
      updatedAt: event.updatedAt,
      hasGroupItems: hasGroupItems,
      groupedOutcomes: groupedOutcomes,
      // Resolution fields
      closedTime: markets.find((m) => m.closedTime)?.closedTime,
      isResolved: isResolved,
    };
  } catch (error) {
    logger.error({
      message: 'Error transforming event',
      eventId: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new TransformationError(
      ErrorCode.TRANSFORMATION_ERROR,
      `Failed to transform event ${event.id}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Group events by ID and merge markets
 * Events with the same ID are merged, with markets combined
 */
function groupEvents(events: PolymarketEvent[]): PolymarketEvent[] {
  const eventMap = new Map<string, PolymarketEvent>();

  for (const event of events) {
    const existingEvent = eventMap.get(event.id);

    if (existingEvent) {
      // Merge markets, avoiding duplicates
      const existingMarketIds = new Set(
        (existingEvent.markets || []).map((m) => m.id)
      );

      const newMarkets = (event.markets || []).filter(
        (m) => !existingMarketIds.has(m.id)
      );

      existingEvent.markets = [
        ...(existingEvent.markets || []),
        ...newMarkets,
      ];

      // Update event-level data with most recent values
      if (event.updatedAt && (!existingEvent.updatedAt || event.updatedAt > existingEvent.updatedAt)) {
        existingEvent.volume24hr = event.volume24hr ?? existingEvent.volume24hr;
        existingEvent.volume1wk = event.volume1wk ?? existingEvent.volume1wk;
        existingEvent.volume1mo = event.volume1mo ?? existingEvent.volume1mo;
        existingEvent.volume1yr = event.volume1yr ?? existingEvent.volume1yr;
        existingEvent.competitive = event.competitive ?? existingEvent.competitive;
        existingEvent.updatedAt = event.updatedAt;
      }

      // Merge tags
      const existingTagIds = new Set(
        (existingEvent.tags || []).map((t) => t.id)
      );
      const newTags = (event.tags || []).filter(
        (t) => !existingTagIds.has(t.id)
      );
      existingEvent.tags = [...(existingEvent.tags || []), ...newTags];
    } else {
      eventMap.set(event.id, { ...event });
    }
  }

  return Array.from(eventMap.values());
}

/**
 * Transform and group events from API response
 */
export function transformEvents(events: PolymarketEvent[]): TransformedEvent[] {
  try {
    if (!Array.isArray(events)) {
      logger.warn({
        message: 'Invalid events data received',
        type: typeof events,
      });
      return [];
    }

    // Group events by ID first
    const groupedEvents = groupEvents(events);

    // Transform grouped events
    const transformed: TransformedEvent[] = [];

    for (const event of groupedEvents) {
      try {
        const transformedEvent = transformEvent(event);
        transformed.push(transformedEvent);
      } catch (error) {
        // Log error but continue processing other events
        logger.error({
          message: 'Failed to transform event, skipping',
          eventId: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Sort by volume24Hr descending
    transformed.sort((a, b) => (b.volume24Hr || 0) - (a.volume24Hr || 0));

    logger.info({
      message: 'Events transformed successfully',
      inputCount: events.length,
      groupedCount: groupedEvents.length,
      outputCount: transformed.length,
    });

    return transformed;
  } catch (error) {
    logger.error({
      message: 'Error in transformEvents',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw new TransformationError(
      ErrorCode.TRANSFORMATION_ERROR,
      `Failed to transform events: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Merge polling data with main data
 * Updates markets in events with latest data from polling endpoint
 */
export function mergePollingData(
  mainEvents: TransformedEvent[],
  pollingEvents: TransformedEvent[]
): TransformedEvent[] {
  const eventMap = new Map<string, TransformedEvent>();

  // Add all main events to map
  for (const event of mainEvents) {
    eventMap.set(event.id, { ...event });
  }

  // Merge polling events
  for (const pollingEvent of pollingEvents) {
    const existingEvent = eventMap.get(pollingEvent.id);

    if (existingEvent) {
      // Merge markets, prioritizing polling data
      const marketMap = new Map<string, TransformedMarket>();

      // Add existing markets
      for (const market of existingEvent.markets) {
        marketMap.set(market.id, { ...market });
      }

      // Update with polling markets (prioritize polling data)
      for (const pollingMarket of pollingEvent.markets) {
        marketMap.set(pollingMarket.id, { ...pollingMarket });
      }

      existingEvent.markets = Array.from(marketMap.values())
        .sort((a, b) => (b.volume || 0) - (a.volume || 0));

      // Update event-level data with polling data if more recent
      existingEvent.volume24Hr = pollingEvent.volume24Hr || existingEvent.volume24Hr;
      existingEvent.totalVolume = pollingEvent.totalVolume || existingEvent.totalVolume;
      existingEvent.competitive = pollingEvent.competitive ?? existingEvent.competitive;
      
      // Update computed fields from polling data (which has latest market data)
      existingEvent.hasGroupItems = pollingEvent.hasGroupItems ?? existingEvent.hasGroupItems;
      existingEvent.groupedOutcomes = pollingEvent.groupedOutcomes || existingEvent.groupedOutcomes;
    } else {
      // New event from polling, add it
      eventMap.set(pollingEvent.id, { ...pollingEvent });
    }
  }

  const merged = Array.from(eventMap.values());
  
  // Re-sort by volume24Hr descending
  merged.sort((a, b) => (b.volume24Hr || 0) - (a.volume24Hr || 0));

  logger.info({
    message: 'Polling data merged',
    mainCount: mainEvents.length,
    pollingCount: pollingEvents.length,
    mergedCount: merged.length,
  });

  return merged;
}

