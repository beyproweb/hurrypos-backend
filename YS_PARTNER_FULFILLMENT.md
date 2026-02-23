# Yemeksepeti Partner Fulfillment (Optional)

If Yemeksepeti customer tracking does **not** leave “Active orders” after Beypro marks an order as delivered, you can optionally try the **Partner Fulfillment PUT** flow (DISPATCHED / READY_FOR_PICKUP) in addition to the middleware callback URLs.

This is **disabled by default** and only runs when `YS_PARTNER_FULFILLMENT_ENABLED=true`.

## How it works

- Beypro extracts the order UUID from `orders.external_order_token` (the token usually contains `oma_<uuid>`).
- On driver status changes to `on_road`/`picked_up`/`delivered`, Beypro sends:
  - `DISPATCHED` for vendor-delivery orders (expeditionType `delivery`)
  - `READY_FOR_PICKUP` for pickup orders (expeditionType `pickup`) if you call it manually
- Endpoint used:
  - `PUT {YS_PARTNER_API_BASE_URL}/v2/chains/{chainCode}/orders/{orderUuid}`

## Required config

- `YS_PARTNER_FULFILLMENT_ENABLED=true`
- `YS_PARTNER_API_BASE_URL` (default: `https://yemeksepeti.partner.deliveryhero.io`)
- **Either**:
  - `YS_PARTNER_API_TOKEN` (recommended): raw token or full `Bearer ...`
  - OR `YS_PARTNER_USERNAME` + `YS_PARTNER_PASSWORD` (fallback login to `/v2/login` if supported)

## Chain code

Set `integrations.yemeksepeti.chainCode` in your restaurant settings (same one used for menu sync).

## Files

- `hurrypos-backend/utils/ysPartnerFulfillment.js`
- `hurrypos-backend/routes/orders.js` (driver-status hooks)

