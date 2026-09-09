# LG/HY controlled listing integration

LG belongs to LUOFANG and HY to WUWEI in config/stores.json. Both owners' existing stores use title3; LG and HY inherit title3. No visual style is invented for the new stores.

The server's optional safeWriteOperations.allowedOperationsByStore narrows the global allowed store/operation gate. Production LG/HY entries allow only copy_product_draft. Account writeStores, live preflight, exact payload, audit and official readback still apply. Marketing/inventory scheduler membership is unchanged.

A loaded, disabled and inactive marketing-repair timer is recognized as intentional manual dispatch, in both the runtime snapshot and watchdog. Enabled-but-inactive timers remain failures. Pending repair queues remain visible; this does not mark business work completed or start the timer.

Reviewed V3 DOCX ingestion accepts paragraph bidi and run rtl formatting without modifying text. The labelled Main Title 3 / English Selling Points / Arabic Selling Points layout is supported alongside the existing score-labelled layout; unique boundaries and exactly five lines per language remain required. The JD389 original SHA256 is 2ec45777f27d1d53cee2b2383cec672030379c16b33c1c2686ab864fafcd8478.

This release changes packaged CLI files, requiring Partner CLI 2026.09.09.1 publication as well as the source release. Application code and scoped runtime configuration must be verified before returning execution to the existing business owners. Never retry their pending submissions.
