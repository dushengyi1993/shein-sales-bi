export const CLOUD_SERVICE_UNITS = Object.freeze([
  'shein-bi-portal.service',
  'shein-bi-webhook.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-db-backup.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-et-low-inventory-guard.service',
  'shein-bi-et-low-inventory-recheck.service',
  'shein-bi-cloud-daily-refresh.service',
  'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-openapi-stock-refresh.service',
  'shein-bi-cloud-today-sales-reconcile.service',
  'shein-bi-cloud-manual-login-recovery.service',
  'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-order-closure.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-et-storage-fee.service',
  'shein-bi-cloud-disk-maintenance.service',
]);

export const CLOUD_ALWAYS_RUNNING_UNITS = Object.freeze([
  'shein-bi-portal.service',
  'shein-bi-webhook.service',
]);

export const CLOUD_TIMER_UNITS = Object.freeze([
  'shein-bi-cloud-yesterday.timer',
  'shein-bi-db-backup.timer',
  'shein-bi-cloud-et-forwarder.timer',
  'shein-bi-et-low-inventory-recheck.timer',
  'shein-bi-cloud-morning-chain.timer',
  'shein-bi-cloud-session-manager.timer',
  'shein-bi-cloud-openapi-stock-refresh.timer',
  'shein-bi-cloud-today-sales-reconcile.timer',
  'shein-bi-cloud-manual-login-recovery.timer',
  'shein-bi-cloud-rtv-verify.timer',
  'shein-bi-cloud-order-closure.timer',
  'shein-bi-cloud-portal-section-queue.timer',
  'shein-bi-cloud-et-storage-fee.timer',
  'shein-bi-cloud-marketing-live-guard.timer',
  'shein-bi-cloud-browser-cleanup.timer',
  'shein-bi-cloud-disk-maintenance.timer',
  'shein-bi-cloud-watchdog.timer',
]);

export const CLOUD_AUXILIARY_UNITS = Object.freeze([
  'shein-bi-cloud-marketing-live-guard.service',
  'shein-bi-cloud-marketing-repair.service',
]);

export const CLOUD_RUNTIME_UNITS = Object.freeze([
  ...new Set([...CLOUD_SERVICE_UNITS, ...CLOUD_TIMER_UNITS, ...CLOUD_AUXILIARY_UNITS]),
]);
