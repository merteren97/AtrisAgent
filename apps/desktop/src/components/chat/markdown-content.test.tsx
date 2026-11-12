import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownContent } from './markdown-content';

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

console.log('Markdown table rendering passed');
