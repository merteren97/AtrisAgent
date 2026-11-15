import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidPortrait, iosPortrait } from './configure-mobile-orientation.mjs';

test('native orientation settings are applied idempotently', () => {
  const android = androidPortrait('<manifest><activity android:name=".MainActivity" android:exported="true"></activity></manifest>');
  assert.match(android, /android:screenOrientation="portrait"/);
  assert.equal(androidPortrait(android), android);
  const ios = iosPortrait('<plist><dict><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationLandscapeLeft</string></array></dict></plist>');
  assert.doesNotMatch(ios, /Landscape/);
  assert.equal((ios.match(/UIInterfaceOrientationPortrait/g) || []).length, 2);
  assert.equal(iosPortrait(ios), ios);
});
