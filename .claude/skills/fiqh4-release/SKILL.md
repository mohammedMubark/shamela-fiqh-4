---
name: fiqh4-release
description: Verification, compliance checks, and MCPB packaging for shamela-fiqh-4 — verify:all, manifest parity, no-network and no-Shamela-data gates, pack, and real-install smoke. Use before committing, opening a PR, or cutting a release.
---

# fiqh4-release — التحقق والحزم

## قبل أي commit

```bash
npm run verify:all
```
= `typecheck` → `build:java` → `fixtures` → `test` → `build:server` → `smoke` → `checks`.
الترتيب مقصود: الفيكستشرز تتضمن فهرس Lucene حقيقيًا فتحتاج `build:java` قبلها.

اختبارات أسرع أثناء العمل: `npm run test:unit` أو `npm run test:integration`.

## بوابات الامتثال الثلاث (`npm run checks`)

| الأمر | يمنع |
| --- | --- |
| `check:manifest` | انحراف `manifest.json` عن `TOOL_NAMES` في `src/server/registerTools.ts` |
| `check:network` | أي استيراد شبكي أو نداء خارج في `src/` |
| `check:data` | تتبّع أو شحن قواعد الشاملة أو نصوص الكتب أو jars أو JRE — ويفحص أرشيف `.mcpb` نفسه |

`check:data` يُعاد تشغيله **بعد** `pack` في CI، لأن الأرشيف هو ما يثبّته المستخدم فعلًا.

## الحزم

```bash
npm run build && npm run pack     # → shamela-fiqh-4.mcpb (من staging إنتاجي فقط)
npx --yes @anthropic-ai/mcpb info shamela-fiqh-4.mcpb
npm run smoke:real                # تشغيل الحزمة كما تُثبَّت
```
ثم تُسحب `.mcpb` إلى Claude Desktop. `.mcpbignore` يحدد المستبعَد.

## على مكتبة حقيقية

```bash
export FIQH4_SHAMELA_DIR=/path/to/shamela   # ويندوز: set FIQH4_SHAMELA_DIR=D:\shamela
npm run fiqh4:verify      # الفئات الموجودة، ما طابقته كل قاعدة وما لم يطابق، والكتب الملتبسة
npm run fiqh4:diagnose
npm run fiqh4:bench       # أو npm run bench على الاصطناعي
```
المراجعات البشرية تُثبَّت في `config/madhhab-overrides.json` — وهي **وحدها** تُنتج `verified`.

## CI

`.github/workflows/ci.yml`: مصفوفة Node 22.x/24.x على ubuntu + 22.x على windows وmacos،
Temurin JDK 21، ثم وظيفة `compliance` منفصلة. **لا توجد مكتبة شاملة في CI ولا ينبغي أن توجد** —
كل شيء يعمل على المجموعة الاصطناعية، وهذا سبب وجود `scripts/make-fixtures.mjs`.

## نظافة المستودع

`hs_err_pid*.log` و`*.mcpb` و`tests/fixtures/generated` و`tests/fixtures/.out-*` نواتج مؤقتة —
لا تُرتكب. راجع `.gitignore` قبل `git add -A`.
