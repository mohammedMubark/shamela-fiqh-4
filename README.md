# shamela-fiqh-4

**إضافة MCP محلية للبحث والمقارنة والتوثيق داخل كتب فقه المذاهب الأربعة في المكتبة الشاملة 4.**

تعمل بلا اتصال بالشبكة، وتفتح ملفات الشاملة للقراءة فقط، ولا تتضمن نصوص الكتب.
هي **أداة بحث وتوثيق ومقارنة، وليست جهة فتوى ولا ترجيحًا آليًا.**

[الاستعمال](docs/USAGE.md) · [البنية](docs/ARCHITECTURE.md) · [سياسة المصادر](docs/SOURCE_POLICY.md) · [دراسة الجدوى](docs/FEASIBILITY.md) · [القياسات](docs/BENCHMARKS.md) · [حل المشكلات](docs/TROUBLESHOOTING.md)

---

## ما الذي تفعله

تبحث في كتب الفقه **الحنفي والمالكي والشافعي والحنبلي** داخل تثبيت المكتبة الشاملة 4 على جهازك،
وتعرض المواضع منسوبة إلى كتبها ومؤلفيها ومذاهبها، مع إحالات دقيقة تصرّح بما تعرفه وبما تجهله.

أسلوب العمل على **مرحلتين**، لأن المسألة الواحدة قد تقع في آلاف المواضع، ومعرفة حجمها قبل جلبها
أفضل من إغراق الاستجابة:

```
fiqh4_discover_issue   →   أين وردت المسألة، وكم موضعًا في كل كتاب، وكيف توزعت على المذاهب
        ↓
fiqh4_fetch_passages   →   اجلب النصوص كتابًا بعد كتاب مع الصفحات المجاورة للسياق
        ↓
fiqh4_compare_issue    →   اعرضها متقابلة، منسوبة إلى مصادرها
```

## ما الذي لا تفعله

هذا القسم ليس تواضعًا، بل تحديد لحدود الأداة:

- **لا تُفتي، ولا ترجّح بين الأقوال، ولا تُثبت إجماعًا.** وهذا **قيد بنيوي**: نوع مخرجات المقارنة
  لا يحوي حقلًا يمكن أن يُكتب فيه حكم، ويتحقق اختبارٌ من ذلك على المخرجات الحقيقية.
- **لا تنسب كتابًا إلى مذهب اعتمادًا على كلمة في عنوانه أو اسم مؤلفه.** مثل هذه الإشارات تُدرج
  في `ambiguity_reasons` وتُرفع الحالة إلى `needs_review`، ولا تُصنِّف.
- **لا تخترع طبعة ولا رقم صفحة.** ما لا تسجّله الشاملة يُعاد `null` بوضوح.
- **لا تقتبس من النص المطبَّع.** الاقتباس من `text_original` حصرًا.
- **لا تعامل خلوّ مذهب من النتائج على أنه نفي لوجود قول له** — هو غياب مطابقة نصية لا أكثر.
- **لا تتصل بالشبكة، ولا تفتح منفذًا، ولا تكتب في مجلد الشاملة.**

## الأدوات التسع

| الأداة | الوظيفة |
| --- | --- |
| `fiqh4_health` | فحص المكتبة والمخطط والفهرس وJava/Lucene، وعدد الكتب في كل مذهب والملتبس منها |
| `fiqh4_guide` | دليل عربي: تسلسل العمل، أمثلة، معاني الحقول، وحدود التغطية |
| `fiqh4_list_books` | سرد الكتب وتصفيتها مع مصدر التصنيف وحالة التحقق، على دفعات |
| `fiqh4_search` | بحث `phrase` / `all_terms` / `any_terms` داخل مذاهب أو كتب محددة |
| `fiqh4_discover_issue` | **المرحلة 1** — تحديد كل الكتب والصفحات التي وردت فيها المسألة |
| `fiqh4_fetch_passages` | **المرحلة 2** — جلب النصوص مع الصفحات المجاورة، بلا تكرار |
| `fiqh4_compare_issue` | تجميع الأدلة حسب المذهب والكتاب، دون حكم ولا ترجيح |
| `fiqh4_export_results` | استقصاء كامل إلى JSONL وMarkdown مع manifest وchecksum واستئناف |
| `fiqh4_citation` | إحالة دقيقة لكتاب/جزء/صفحة مع التصريح بترقيم الشاملة |

## التشغيل السريع

```bash
git clone https://github.com/mohammedMubark/shamela-fiqh-4.git
cd shamela-fiqh-4
npm install && npm run build     # يترجم الخادم ومساعد Lucene

export FIQH4_SHAMELA_DIR=/path/to/shamela      # ويندوز: set FIQH4_SHAMELA_DIR=D:\shamela

npm run fiqh4:verify     # افحص مكتبتك وفئاتها وتصنيفها — قبل أي اعتماد على النسب
npm run pack             # ينتج shamela-fiqh-4.mcpb
```

ثم اسحب `shamela-fiqh-4.mcpb` إلى Claude Desktop.

**يتطلب Node ≥ 22.5** لوحدة `node:sqlite` المدمجة، و**JDK 21 وقت البناء فقط** لترجمة مساعد
Lucene (التشغيل يستعمل Java الشاملة). التفاصيل في [USAGE.md](docs/USAGE.md).

## تصنيف الكتب: الإعلان بدل الإخفاء

لا يوجد في بيانات الشاملة حقل «مذهب». المتاح هو **الفئة**، وهي غير مستقرة الأرقام وغير كاملة
وغير حاسمة. فبدل التظاهر بيقين غير موجود، تُعلن الأداة درجة ثقتها في كل صف:

| الأسبقية | المصدر | `classification_source` | `verification_status` |
| --- | --- | --- | --- |
| 1 | تجاوز يكتبه إنسان | `override` | `verified` |
| 2 | اسم الفئة (بعد التطبيع، لا رقمها) | `category_map` | `unverified` / `needs_review` |
| 3 | لا شيء | `unclassified` | `unverified` / `needs_review` |

القيم: `hanafi` `maliki` `shafii` `hanbali` `comparative` `unclassified`.

**النطاق محصور في أقسام المذاهب الأربعة فقط** كما تسميها الشاملة: «الفقه الحنفي» و«الفقه المالكي»
و«الفقه الشافعي» و«الفقه الحنبلي». وأقسام مثل «الفقه العام» و«أصول الفقه» و«علوم الفقه والقواعد
الفقهية» **خارج النطاق** ولا تُنسب إلى مذهب — المطابقة تامة على اسم القسم، فلا يلتقط «أصول الفقه
الحنبلي» بالخطأ. من أراد إدراجها أضافها بنفسه في `config/madhhab-overrides.json`.

`npm run fiqh4:verify` يعرض على مكتبتك الحقيقية: الفئات الموجودة، وما طابقته كل قاعدة (وما لم
تطابق شيئًا)، والكتب الملتبسة مع أسباب التباسها. ثم تثبّت مراجعاتك في
`config/madhhab-overrides.json` — وهي وحدها تُنتج `verified`.

## النتائج الكبيرة

كل استجابة تحمل `total_hits` (**دقيقًا دائمًا**) و`returned` و`has_more` و`next_cursor`
و`truncated` و`truncation_reason`. **لا اقتطاع صامت أبدًا.**

الترحيل بـ keyset لا بـ `offset`، والمؤشر مربوط ببصمة الفهرس وhash الاستعلام: إن أُعيد بناء
الفهرس أو تغيّر الاستعلام يُرفض المؤشر بـ `CURSOR_STALE` بدل إعادة التصفير بصمت.

وللاستقصاء الكامل، `fiqh4_export_results` يمسح كل كتاب حتى النهاية ويكتب تدفقيًا مع
checkpoint/resume. مقيسًا على مجموعة اصطناعية من 77,800 صفحة، بنطاق المذاهب الأربعة:

| | |
| --- | --- |
| تصدير **58,239 موضعًا** بالنص الكامل | **4.4 ثانية** (13,378 موضع/ثانية)، 56 م.ب مكتوبة |
| ترحيل 58,239 موضعًا | **مكتمل 100%**، نمو ذاكرة **+20.8 م.ب** |
| ترحيل 2,838 موضعًا (‎20.5× أقل) | نمو ذاكرة **+22.7 م.ب** — أي **لا علاقة بين حجم النتيجة والذاكرة** |

وكذلك **كلفة الاستدعاء الواحد**: يبقى مساعد Lucene حيًّا بين الاستدعاءات بدل أن يُفتح
ويُغلق في كل نداء، فينزل زمن `fiqh4_search` من ‎525 م.ث إلى ‎23 م.ث — **أسرع 23 مرة**،
والفارق أكبر على مكتبة حقيقية لأن كلفة فتح فهرسها أكبر.

التفاصيل وحدود الأداء المعروفة في [BENCHMARKS.md](docs/BENCHMARKS.md).

## من أين يُقرأ النص

**الشاملة 4 لا تخزّن نصوص الكتب في SQLite.** ملف الكتاب يحمل الترقيم فقط (الجزء والصفحة وشجرة
الفهرس)، أمّا نص الصفحات وعناوين الفهرس فَفي فهارس Lucene تحت `database/store`.

| ما نقرؤه | من أين |
| --- | --- |
| فهرس الكتب والمؤلفين والتصنيفات | `database/master.db` |
| الجزء والصفحة المطبوعة وشجرة الفهرس | `database/book/<آخر ٣ أرقام>/<book_id>.db` |
| **نص الصفحة والحاشية** | `database/store/page` (فهرس Lucene) |
| **نص عناوين الفهرس** | `database/store/title` |

وبما أن **الشاملة فهرست كل صفحة سلفًا**، تستعلم هذه الإضافة فهرسها مباشرة: **لا خطوة فهرسة،
ولا مساحة قرص إضافية، ولا انتظار.**

### لا تُشحن Java ولا Lucene

الشاملة تشحن نسختها من Java (`app/<نظام>/jre/2/bin`) ومن مكتبات Lucene (`app/lucene/2`)،
والإضافة تستعملهما. فالحزمة تتضمن **بضعة كيلوبايتات من الأصناف المترجَمة فقط** — لا jar ولا JRE،
ولا شيء تبنيه أنت.

المطابقة تجري بعد تطبيع عربي يماثل تطبيع الشاملة نفسها (`shamela-compat-1`)، لأن الكلمة المطوية
بقواعد أخرى لا تطابق ما خزّنته الشاملة أصلًا.

## الاختبارات

```bash
npm run typecheck && npm test && npm run build && npm run smoke && npm run checks
```

**174 اختبارًا** تغطي: التصنيف وأسبقيته، التطبيع واختبارات التصادم، المؤشرات وبطلانها،
`searchAfter` واكتمال الترحيل، إزالة التكرار، الإحالات، أكثر من 10 كتب، الاستئناف بعد الانقطاع،
الكتب غير المنزلة، والمسارات الآمنة. تعمل كلها على **مجموعة اصطناعية مُولَّدة** لا تحوي نصًّا لأي كتاب — وهي مبنية على **بنية الشاملة 4
الحقيقية**: جدول صفحات بلا عمود نص، وفهرس Lucene حقيقي بجواره. النسخة السابقة من التركيبات كانت
تفترض عمود نص لا وجود له، فمرّت اختباراتها كلها على معمارية لا تصلح لأي مكتبة حقيقية.

ويضاف إليها فحوص امتثال: تطابق `manifest.json` مع الأدوات المسجَّلة، وخلوّ `src/` من أي وحدة
شبكية، وخلوّ الحزمة من قواعد الشاملة وjars وJRE.

---

## English summary

**shamela-fiqh-4** is a local, offline MCP extension for Claude Desktop that searches and compares
the four Sunni fiqh madhhabs — Hanafi, Maliki, Shafi'i, Hanbali — across a Shamela 4 library
installed on the user's own machine.

It is a **search, citation, and comparison instrument — not a source of rulings.** It does not
issue fatwas, weigh scholarly positions, or assert consensus; the comparison output type has no
field a verdict could be written into, and a test enforces that against real output.

**Design commitments, each enforced rather than promised:**

- **Read-only.** Shamela files open with SQLite's `readOnly` flag, so the engine itself rejects
  writes. Export paths are validated against realpath and refuse anything inside the library.
- **No network, no ports.** Only the MCP stdio transport is imported; a check script fails the
  build if anything in `src/` reaches for a networking module.
- **Ships no content.** No book text, no Shamela databases, no JRE, no Lucene jars. Tests run
  against a generated synthetic corpus.
- **Schema discovered, not assumed.** No table name, column name, or category ID is hardcoded —
  Shamela repacks vary and category IDs are not stable across installations.
- **Attribution never invented.** Missing edition, printed page, volume, or heading path come back
  as `null` or `[]`. A book is never assigned a madhhab from a word in its title or its author's
  name; such hints only raise `needs_review`.
- **Quotes come from the original.** A conservative, versioned Arabic normaliser powers search,
  but an offset map cuts every excerpt from the untouched source text.
- **Never silently truncated.** Every response carries an exact `total_hits` plus
  `truncated` / `truncation_reason`; cursors are bound to an index fingerprint and query hash and
  are rejected when stale rather than silently restarting.

**Where the text comes from.** Shamela 4 keeps no book text in SQLite: a book's database holds
pagination, while page bodies and heading text live in Lucene indexes under `database/store`. This
extension queries *that* index rather than building its own — no indexing step, no extra disk, and
results that are current the moment Shamela finishes a download. Query terms are folded with
Shamela's own rules, because a term folded any other way cannot match what Shamela stored.

**Nothing is bundled.** Shamela ships its own JRE and its own Lucene jars, and the helper runs on
those; the package carries only a few kilobytes of compiled classes. A JDK is needed to build, never
to run.

Requires **Node ≥ 22.5** for the built-in `node:sqlite` module. See [USAGE.md](docs/USAGE.md).

---

## الترخيص

MIT — انظر [LICENSE](LICENSE) و[NOTICE](NOTICE).

هذا المشروع أداة برمجية فقط. حقوق كتب المكتبة الشاملة وبرنامجها لأصحابها، والمستخدم مسؤول عن
موافقة استعماله لشروط ترخيصها.
