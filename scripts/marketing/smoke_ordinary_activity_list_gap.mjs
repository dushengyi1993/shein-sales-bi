import assert from 'node:assert/strict';
import {ordinaryActivityListGap} from '../../lib/marketing_ordinary_activity_list_gap.mjs';

assert.equal(ordinaryActivityListGap(46, 45), 1);
assert.equal(ordinaryActivityListGap(46, 46), 0);
assert.equal(ordinaryActivityListGap(46, 47), 0);
assert.equal(ordinaryActivityListGap(null, 10), 0);
assert.equal(ordinaryActivityListGap(10, undefined), 0);

console.log('smoke_ordinary_activity_list_gap: OK');
