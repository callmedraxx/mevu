-- Migration: Add NOT_FILLED to trades_history status constraint
-- FOK/FAK orders that pass CLOB but fail verification are marked NOT_FILLED.
-- Without this, updateTradeRecordById fails with: violates check constraint "trades_history_status_check"

ALTER TABLE trades_history DROP CONSTRAINT IF EXISTS trades_history_status_check;

ALTER TABLE trades_history ADD CONSTRAINT trades_history_status_check
  CHECK (status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'FAILED', 'NOT_FILLED'));

COMMENT ON COLUMN trades_history.status IS 'Trade status: PENDING, FILLED, PARTIALLY_FILLED, CANCELLED, FAILED, or NOT_FILLED (FOK/FAK accepted but no fill confirmed)';
