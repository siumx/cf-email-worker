import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const manifest = JSON.parse(read("public/locales/manifest.json"));
const dictionaries = Object.fromEntries(manifest.map(({ code }) => [code, JSON.parse(read(`public/locales/${code}.json`))]));

function browserContext(options = {}) {
  const context = vm.createContext({ Intl, Date, console, setTimeout, clearTimeout, URLSearchParams, ...options });
  context.window = context;
  for (const path of ["public/lib/i18next.js", "public/js/utils.js", "public/js/api.js"]) {
    vm.runInContext(read(path), context, { filename: path });
  }
  return context;
}

const { MailUtils: utils } = browserContext();
const plain = (value) => JSON.parse(JSON.stringify(value));

function flatten(value, prefix = "") {
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [[path, child]] : Object.entries(flatten(child, path));
  }));
}

const baseKey = (key) => key.replace(/_(zero|one|two|few|many|other)$/, "");

test("each registered language covers the UI keys and interpolation parameters", () => {
  const baseline = flatten(dictionaries[utils.DEFAULT_LANGUAGE]);
  const expected = new Map(Object.entries(baseline).map(([key, value]) => [baseKey(key), [...value.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort()]));
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    const actual = flatten(dictionary);
    assert.deepEqual(new Set(Object.keys(actual).map(baseKey)), new Set(expected.keys()), language);
    for (const [key, value] of Object.entries(actual)) {
      assert.deepEqual([...value.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort(), expected.get(baseKey(key)), `${language}:${key}`);
    }
  }
  const source = ["public/index.html", "public/mail.html", "public/js/app.js"].map(read).join("\n");
  for (const [, key] of source.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([a-zA-Z.]+)"/g)) {
    assert.ok(expected.has(key), `Missing UI key: ${key}`);
  }
  for (const [, key] of source.matchAll(/"((?:common|settings|inbox|compose|mail|errors)\.[a-zA-Z.]+)"/g)) {
    assert.ok(expected.has(key), `Missing dynamic UI key: ${key}`);
  }
});

test("English is the default and saved language choices are preserved", () => {
  assert.equal(utils.resolvePreferences({}, manifest).language, "en");
  assert.equal(utils.resolvePreferences({ language: "zh-Hant" }, manifest).language, "zh-Hant");
  assert.equal(utils.resolvePreferences({ language: "removed" }, manifest).language, "en");
  const expanded = [...manifest, { code: "ja", label: "日本語" }];
  assert.equal(utils.resolvePreferences({ language: "ja" }, expanded).language, "ja");
});

test("time-zone preferences are independent, validated and default to UTC+8", () => {
  assert.deepEqual(plain(utils.resolvePreferences({}, manifest)), { language: "en", timeZone: "Asia/Singapore" });
  assert.equal(utils.resolvePreferences({ timeZone: "America/New_York" }, manifest).timeZone, "America/New_York");
  for (const value of [null, "", "invalid/zone", 8, {}, true]) assert.equal(utils.normalizeTimeZone(value), "Asia/Singapore");
  assert.ok(utils.getTimeZones("UTC").includes("UTC"));
  assert.ok(utils.getTimeZones("Asia/Kolkata").includes("Asia/Kolkata"));
});

test("UTC instants display correctly across midnight, fractional offsets and daylight saving", () => {
  const iso = "2026-10-30T20:30:00.000Z";
  assert.equal(utils.formatDate(iso, "en-GB", "Asia/Singapore"), "31/10/2026, 04:30");
  assert.equal(utils.formatDate(iso, "en-GB", "UTC"), "30/10/2026, 20:30");
  assert.equal(utils.formatDate(iso, "en-GB", "Asia/Kolkata"), "31/10/2026, 02:00");
  assert.equal(utils.formatDate("2026-03-08T06:59:00Z", "en-GB", "America/New_York"), "08/03/2026, 01:59");
  assert.equal(utils.formatDate("2026-03-08T07:00:00Z", "en-GB", "America/New_York"), "08/03/2026, 03:00");
  assert.equal(utils.formatDate("2026-10-30T00:00:00Z", "en-US", "UTC"), "10/30/2026, 00:00");
  assert.equal(utils.formatDate("invalid", "en", "UTC"), "invalid");
  assert.equal(utils.formatDate("", "en", "UTC"), "");
});

test("i18next switches languages, handles plurals and falls back to English", async () => {
  const { i18next } = browserContext();
  const chinese = structuredClone(dictionaries["zh-Hant"]);
  delete chinese.inbox.subtitle;
  await i18next.init({
    lng: "zh-Hant", fallbackLng: utils.DEFAULT_LANGUAGE, load: "currentOnly", interpolation: { escapeValue: false },
    resources: { en: { translation: dictionaries.en }, "zh-Hant": { translation: chinese } }
  });
  assert.equal(i18next.t("inbox.subtitle"), "Your latest messages");
  assert.equal(i18next.t("inbox.refreshCountdown", { count: 1 }), "1 秒後自動刷新");
  await i18next.changeLanguage("en");
  assert.equal(i18next.t("inbox.refreshCountdown", { count: 1 }), "Auto refresh in 1 second");
  assert.equal(i18next.t("inbox.refreshCountdown", { count: 2 }), "Auto refresh in 2 seconds");
  assert.equal(i18next.t("compose.removeAttachment", { filename: "A & B <notes>.txt" }), "Remove A & B <notes>.txt");
});

test("preferences survive reload and malformed or blocked storage remains usable", () => {
  let saved;
  const { MailApi } = browserContext({ localStorage: { getItem: () => saved, setItem: (key, value) => { assert.equal(key, "email-worker.preferences"); saved = value; } } });
  const preferences = { language: "en", timeZone: "UTC" };
  MailApi.savePreferences(preferences);
  assert.deepEqual(plain(MailApi.readPreferences()), preferences);
  saved = "not json";
  assert.deepEqual(plain(MailApi.readPreferences()), {});
  const blocked = browserContext({ localStorage: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } }).MailApi;
  assert.deepEqual(plain(blocked.readPreferences()), {});
  assert.doesNotThrow(() => blocked.savePreferences(preferences));
});

test("API failures retain stable codes and status for localized messages", async () => {
  const { MailApi } = browserContext({ fetch: async () => new Response(JSON.stringify({ error: "Original diagnostic", code: "SENDER_DOMAIN_NOT_ALLOWED" }), { status: 400 }) });
  await assert.rejects(MailApi.sendMail({}), (error) => {
    assert.equal(error.code, "SENDER_DOMAIN_NOT_ALLOWED");
    assert.equal(error.status, 400);
    assert.equal(error.message, "Original diagnostic");
    return true;
  });
});

function loadWorkerModules() {
  const now = Date.parse("2026-10-30T20:30:00.000Z");
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const exports = {};
    modules.set(name, exports);
    const code = ts.transpileModule(read(`src/${name}.ts`), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const context = {
      exports, Date: FixedDate, Headers, Response, Request, URL, crypto,
      TextDecoder, TextEncoder, ReadableStream, ArrayBuffer, atob, btoa, console,
      require(specifier) {
        if (specifier === "cloudflare:email") return { EmailMessage: class { constructor(from, to, raw) { Object.assign(this, { from, to, raw }); } } };
        return load(specifier.replace("./", ""));
      }
    };
    vm.runInNewContext(code, context, { filename: `src/${name}.ts` });
    return exports;
  }
  return { handlers: load("handlers"), utils: load("utils"), now };
}

test("backend stores inbound, outbound and failure timestamps in UTC without shifting the instant", async () => {
  const { handlers, utils: workerUtils, now } = loadWorkerModules();
  const inserted = [];
  const env = {
    ADMIN_MAIL_HOSTS: ["admin.example.com"], SENDABLE_DOMAINS: ["example.com"],
    DB: { prepare() { return { bind(...values) { return { async run() { inserted.push(values); } }; } }; } },
    EMAIL: { async send(message) { if (message.to === "fail@example.com") throw new Error("Rejected"); assert.match(message.raw, /Date: Fri, 30 Oct 2026 20:30:00 GMT/); } }
  };
  await handlers.storeIncomingMail({
    from: "sender@example.com", to: "reader@example.com",
    headers: new Headers({ from: "sender@example.com", subject: "Original", date: "Fri, 30 Oct 2026 13:30:00 -0700" }),
    raw: "From: sender@example.com\r\nSubject: Original\r\n\r\nOriginal body"
  }, env);
  const request = new Request("https://admin.example.com/api/send", { method: "POST", body: JSON.stringify({ from: "sender@example.com", to: ["reader@example.com", "fail@example.com"], subject: "Test", text: "Body" }) });
  assert.equal((await handlers.handleSendEmail(request, env, "admin.example.com")).status, 200);
  assert.equal(inserted.length, 3);
  for (const row of inserted) {
    assert.equal(row[2], "2026-10-30T20:30:00.000Z");
    assert.equal(row[3], now);
  }
  assert.equal(JSON.parse(inserted[0][7]).date, "Fri, 30 Oct 2026 13:30:00 -0700");
  const response = workerUtils.jsonError("Original error", 400, "INVALID_REQUEST");
  assert.deepEqual(await response.json(), { error: "Original error", code: "INVALID_REQUEST" });
});
