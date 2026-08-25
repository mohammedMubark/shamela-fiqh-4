# حل المشكلات — shamela-fiqh-4

ابدأ دائمًا بـ `fiqh4_health`. هو يفحص المكتبة، Java، فهارس Lucene، والتصنيف.

## المكتبة لا تُكتشف

اضبط:

```text
FIQH4_SHAMELA_DIR=D:\shamela
```

المجلد الصحيح هو جذر الشاملة الذي يحتوي على `database` و`app`، لا مجلد كتاب منفرد ولا مجلد `store`.

## Java لا تُكتشف

الإضافة تبحث بالترتيب عن:

1. المسار المضبوط في `FIQH4_JAVA_PATH`.
2. Java المحزومة مع الشاملة.
3. `java` من `PATH`.

إن فشل `fiqh4_health` في Java، اضبط المسار الكامل إلى `java.exe`:

```text
FIQH4_JAVA_PATH=D:\shamela\...\java.exe
```

## فهارس Lucene لا تُقرأ

تحقق من وجود:

```text
D:\shamela\database\store\page
D:\shamela\database\store\title
D:\shamela\app\lucene\2
```

الحزمة لا تشحن Lucene jars. تستخدم ملفات Lucene الموجودة مع برنامج الشاملة نفسه. إن تغيّر توزيع الشاملة، سيظهر المسار المجرّب في `fiqh4_health`.

## البحث لا يجد شيئًا

الأسباب المعتادة:

- الكتاب له SQLite هيكلي لكنه لا يملك وثائق في فهرس `page`.
- النطاق محصور في المذاهب الأربعة، والكتاب خارج هذه الأقسام.
- `phrase` صارم؛ جرّب `all_terms`.
- المسألة وردت بألفاظ أخرى؛ البحث نصي لا دلالي.

استخدم `fiqh4_list_books` مع `downloaded_only: true` وراجع `verification_status`.

## `CURSOR_STALE`

هذا مقصود. يعني أن المؤشر صدر عن بيانات مختلفة:

- تغيّر commit فهرس Lucene في الشاملة.
- تغيّر الاستعلام أو نمط المطابقة.
- تغيّر نطاق الكتب أو المذاهب.
- تغيّر إصدار التطبيع.

أعد البحث من البداية.

## التصنيف يبدو غير موثوق

هذا متوقع حتى تُراجع الكتب المهمة. المطابقة المؤكدة لاسم قسم الشاملة تعطي `unverified` فقط. الحالة `verified` لا تنتج إلا من:

```json
{
  "overrides": [
    { "book_id": "1234", "madhhab": "shafii", "reason": "مراجعة بشرية بتاريخ ..." }
  ]
}
```

ثم شغّل `fiqh4_health` مع `refresh: true`.

## التصدير يرفض المسار

الأداة لا تكتب داخل مجلد الشاملة ولا خارج جذر الإخراج المضبوط. استخدم `FIQH4_OUTPUT_DIR` لمجلد آمن، ثم مرّر مسارًا داخله فقط.

## الإضافة لا تظهر في Claude Desktop

1. ثبّت ملف `.mcpb` لا مجلد المصدر.
2. أعد تشغيل Claude Desktop.
3. تحقق من أن الحزمة مبنية:

```bash
npm run build
npm run smoke
node scripts/pack-mcpb.mjs
```

## تشخيص للمطور

```bash
npm run typecheck
npm run java:build
npm run fixtures
npm test
npm run build
npm run smoke
npm run checks
npm run fiqh4:verify -- --out verify.json
```

عند فتح مشكلة، أرفق مخرجات `fiqh4_health` أو `verify.json` بعد حذف أي مسارات لا تريد نشرها. لا تنشر نصوص كتب.

