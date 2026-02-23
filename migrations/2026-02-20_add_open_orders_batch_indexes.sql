-- Phase 2: support batched open-order queries used by TableOverview
CREATE INDEX IF NOT EXISTS idx_orders_restaurant_status_type
  ON orders(restaurant_id, status, order_type);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
  ON order_items(order_id);
