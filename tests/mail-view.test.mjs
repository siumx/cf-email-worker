import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/utils.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
});
const exports = {};
vm.runInNewContext(outputText, { exports, TextEncoder, TextDecoder, atob, btoa });
const { buildMailView, extractAttachmentsFromRaw } = exports;
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function imagePart(contentId, filename = "cover.png", disposition = "inline", content = pixel) {
  return `Content-Type: image/png\nContent-Disposition: ${disposition}; filename="${filename}"\nContent-ID: <${contentId}>\nContent-Transfer-Encoding: base64\n\n${content}`;
}

function mailWithHtml(html, parts = []) {
  const rawText = [
    'Content-Type: multipart/mixed; boundary="mixed"', "", "--mixed",
    'Content-Type: multipart/alternative; boundary="alternative"', "", "--alternative",
    "Content-Type: text/plain; charset=utf-8", "", "Plain text fallback", "--alternative",
    "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    Buffer.from(html).toString("base64"), "--alternative--",
    ...parts.flatMap((part) => ["--mixed", part]), "--mixed--"
  ].join("\r\n");
  return { rawText, attachments: extractAttachmentsFromRaw(rawText) };
}

test("multipart mail retains both bodies and does not turn image links into embedded images", () => {
  const html = '<p>Welcome <strong>reader</strong></p><a href="https://example.com/cover.png">cover.png</a>';
  const mail = mailWithHtml(html, [imagePart("cover", "cover.png", "attachment")]);
  const view = buildMailView(mail);
  assert.match(view.renderedHtml, /<strong>reader<\/strong>/);
  assert.match(view.renderedHtml, /href="https:\/\/example.com\/cover.png"/);
  assert.doesNotMatch(view.renderedHtml, /<img/);
  assert.equal(view.renderedText.trim(), "Plain text fallback");
  assert.equal(view.inlineAttachmentIds.length, 0);
  assert.equal(mail.attachments.length, 1);
});

test("only images resolved into the HTML body are marked as inline attachments", () => {
  const mail = mailWithHtml('<img src="cid:cover"><img src="cid:cover">', [
    imagePart("cover"), imagePart("unused", "unused.png"),
    imagePart("download", "download.png", "attachment"),
    'Content-Type: application/pdf\nContent-Disposition: attachment; filename="report.pdf"\n\nPDF'
  ]);
  const view = buildMailView(mail);
  assert.equal(view.renderedHtml.match(/src="data:image\/png;base64,/g).length, 2);
  assert.deepEqual(Array.from(view.inlineAttachmentIds), [mail.attachments[0].id]);
  assert.equal(mail.attachments.length, 4, "Original attachments remain stored and downloadable");
});

test("CID matching supports encoded IDs, HTML entities and unquoted image sources", () => {
  const mail = mailWithHtml('<img src="CID:%3Ccover%40example%3E"><img src=cid:logo&amp;icon>', [
    imagePart("cover@example"), imagePart("logo&icon", "logo.png")
  ]);
  const view = buildMailView(mail);
  assert.doesNotMatch(view.renderedHtml, /src=["']?cid:/i);
  assert.deepEqual(Array.from(view.inlineAttachmentIds), Array.from(mail.attachments, ({ id }) => id));
});

test("missing, invalid, empty and non-image CID sources do not hide attachments", () => {
  const mail = mailWithHtml('<img src="cid:missing"><img src="cid:%ZZ"><img src="cid:document"><img src="cid:empty">', [
    imagePart("unused"), imagePart("empty", "empty.png", "inline", ""),
    'Content-Type: application/pdf\nContent-Disposition: attachment; filename="report.pdf"\nContent-ID: <document>\n\nPDF'
  ]);
  const view = buildMailView(mail);
  assert.equal(view.inlineAttachmentIds.length, 0);
});

test("images in removed scripts, iframes and comments do not hide attachments", () => {
  const mail = mailWithHtml('<script><img src="cid:cover"></script><iframe><img src="cid:cover"></iframe><!-- <img src="cid:cover"> --><p>Body</p>', [imagePart("cover")]);
  const view = buildMailView(mail);
  assert.doesNotMatch(view.renderedHtml, /<script|<iframe/i);
  assert.equal(view.inlineAttachmentIds.length, 0);
});

test("remote images and sender HTML/body styling survive mail parsing", () => {
  const html = '<html lang="zh-Hant" dir="rtl"><head><style>p { color: red }</style></head><body bgcolor="#fff" style="background: #fff; color: #123"><p>你好</p><img src="https://example.com/cover.png"></body></html>';
  const view = buildMailView(mailWithHtml(html));
  assert.match(view.renderedHtml, /lang="zh-Hant" dir="rtl"/);
  assert.match(view.renderedHtml, /body bgcolor="#fff" style="background: #fff; color: #123"/);
  assert.match(view.renderedHtml, /src="https:\/\/example.com\/cover.png"/);
  assert.equal(view.inlineAttachmentIds.length, 0);
});

test("plain text and attachment-only messages have no inline attachment IDs", () => {
  const textView = buildMailView({ rawText: "Content-Type: text/plain\n\n<literal text>", attachments: [] });
  assert.equal(textView.renderedHtml, null);
  assert.equal(textView.renderedText, "<literal text>");
  assert.equal(textView.inlineAttachmentIds.length, 0);
  const emptyView = buildMailView({ rawText: "Content-Type: application/octet-stream\n\n", attachments: [] });
  assert.equal(emptyView.renderedHtml, null);
  assert.equal(emptyView.renderedText, null);
  assert.equal(emptyView.inlineAttachmentIds.length, 0);
});
