import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from './markdown-content';
import { browserUrl, useBrowserStore } from '@/stores/browser-store';

const render = (content: string) => renderToStaticMarkup(<MarkdownContent content={content} />);

const table = render('Intro\n| Name | Result |\n| :--- | ---: |\n| **Agent** | `ok` |\n| A \\| B | done |');
assert.match(table, /<table/);
assert.match(table, /<th[^>]*scope="col"/);
assert.match(table, /<strong[^>]*>Agent<\/strong>/);
assert.match(table, /A \| B/);
assert.match(table, /text-align:right/);
assert.match(table, /<p[^>]*>Intro<\/p>/);
assert.doesNotMatch(render('```\n| A | B |\n| --- | --- |\n```'), /<table/);
assert.doesNotMatch(render('| A | B |\n| --- |'), /<table/);
const links = render('[Pull request](https://example.com/review) and https://example.com/docs.');
assert.match(links, /href="https:\/\/example\.com\/review"/);
assert.match(links, /href="https:\/\/example\.com\/docs"/);
assert.match(render('[Article](https://example.com/wiki/Title_(test))'), /href="https:\/\/example\.com\/wiki\/Title_\(test\)"/);
assert.match(render('(https://example.com/path).'), /href="https:\/\/example\.com\/path"/);
assert.doesNotMatch(render('`https://example.com`'), /<a /);
for (const unsafe of ['javascript:alert(1)','file:///tmp/secret','https://user:pass@example.com']) assert.equal(browserUrl(unsafe),null);
useBrowserStore.getState().open('https://example.com');
assert.equal(useBrowserStore.getState().url,'https://example.com/');
useBrowserStore.getState().open('javascript:alert(1)');
assert.equal(useBrowserStore.getState().url,'https://example.com/');
useBrowserStore.getState().close();

console.log('Markdown table rendering passed');
