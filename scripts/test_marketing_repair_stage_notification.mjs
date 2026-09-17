#!/usr/bin/env node
// The repair worker's serial stages (highClickSpecial / manualSpecialRestore /
// fallbackRepair) consume one item (or one group) per loop iteration and call
// update_stage once per item. Hanging the Feishu notification on that function
// therefore posted one message per item: on 2026-09-17 a single day produced
// 161 marketing-fallbackRepair + 37 marketing-manualSpecialRestore + 2
// marketing-highClickSpecial messages, each covering one or two links.
//
// Contract: only a terminal stage outcome (completed / blocked / failed) may
// notify, the day's own summary stays the single daily message, and every
// stage loop must keep its per-item call marked pending so it cannot notify.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile('scripts/cloud_marketing_repair_worker.sh', 'utf8');
const updateStage = source.slice(source.indexOf('update_stage() {'), source.indexOf('send_daily_group_report() {'));
assert.ok(updateStage.length > 500, 'update_stage body must be found');

assert.match(updateStage, /local terminal_stage=0/);
assert.match(updateStage, /case "\$status" in\s*\n\s*completed\|blocked\|failed\) terminal_stage=1 ;;/, 'only terminal outcomes may notify');
assert.match(updateStage, /if \(\( command_status == 0 && terminal_stage == 1 \)\)/, 'the delivery guard must require a terminal stage');
assert.ok(!/if \(\( command_status == 0 \)\) && \[\[ -n "\$result_path"/.test(updateStage), 'the old unconditional delivery guard must be gone');

const loops = {
  highClickSpecial: source.slice(source.indexOf('HIGH_CLICK_STATUS='), source.indexOf('MANUAL_STATUS=')),
  manualSpecialRestore: source.slice(source.indexOf('MANUAL_STATUS='), source.indexOf('DRIFT_STATUS=')),
  fallbackRepair: source.slice(source.indexOf('FALLBACK_STATUS='), source.indexOf('QUEUE_STATUS=', source.indexOf('FALLBACK_STATUS='))),
};
for (const [stage, body] of Object.entries(loops)) {
  assert.ok(body.length > 500, `${stage} loop body must be found`);
  const continuing = body.match(new RegExp(`update_stage ${stage} pending`, 'g')) || [];
  assert.ok(continuing.length > 0, `${stage} must still mark its per-item progress as pending`);
  // No stage may announce a mid-loop step as terminal. Every terminal call must
  // carry a closing detail (all items accounted / settled), not "continuing".
  for (const match of body.matchAll(new RegExp(`update_stage ${stage} (completed|blocked|failed)([^\\n]*)`, 'g'))) {
    assert.ok(!/continuing|serial consumer|one exact/i.test(match[2]),
      `${stage} must not notify a mid-loop step as a terminal stage: ${match[0].trim()}`);
  }
}

// The day's own summary remains the single daily message.
assert.match(source, /send_daily_group_report\(\)/, 'the daily group report must still exist');
assert.match(source, /send_marketing_daily_group_report\.mjs/, 'the daily summary must keep its dedicated sender');

console.log(JSON.stringify({ok: true, test: 'marketing_repair_stage_notification_terminal_only', checks: [
  'terminal_statuses_only', 'per_item_progress_stays_pending', 'daily_summary_unchanged',
]}));
