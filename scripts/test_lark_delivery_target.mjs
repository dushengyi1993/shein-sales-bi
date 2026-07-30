#!/usr/bin/env node
import assert from 'node:assert/strict';
import {maskLarkDeliveryTarget, resolveLarkDeliveryTarget} from '../lib/lark_delivery_target.mjs';

const chat = resolveLarkDeliveryTarget({
  config: {recipientChatId: 'oc_group123', recipientUserId: 'ou_owner123'},
});
assert.equal(chat.type, 'chat');
assert.deepEqual(chat.cliArgs, ['--chat-id', 'oc_group123']);
assert.match(maskLarkDeliveryTarget(chat), /^chat:oc_gr\.\.\.p123$/);

const user = resolveLarkDeliveryTarget({config: {recipientUserId: 'ou_owner123'}});
assert.equal(user.type, 'user');
assert.deepEqual(user.cliArgs, ['--user-id', 'ou_owner123']);
assert.equal(resolveLarkDeliveryTarget({config: {}}), null);
assert.throws(() => resolveLarkDeliveryTarget({config: {recipientChatId: 'bad'}}), /Invalid/);

console.log('lark_delivery_target: group target precedence and DM fallback passed');
