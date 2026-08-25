---
name: fiqh4-mcp-tool
description: How to add or change an MCP tool in shamela-fiqh-4 — Zod output schemas, structuredContent, typed errors, batch envelope, and keeping manifest.json in parity. Use when touching src/tools/, src/server/registerTools.ts, or manifest.json.
---

# fiqh4-mcp-tool — إضافة أداة أو تعديلها

## الأدوات التسع

`fiqh4_health` `fiqh4_guide` `fiqh4_list_books` `fiqh4_search` `fiqh4_discover_issue`
`fiqh4_fetch_passages` `fiqh4_compare_issue` `fiqh4_export_results` `fiqh4_citation`

سير العمل المقصود للمستخدم: `discover_issue` (كم موضعًا وأين) → `fetch_passages` (النصوص) →
`compare_issue` (عرض متقابل) → `citation` (إحالة).

## خطوات الإضافة

1. أنشئ `src/tools/<name>.ts` يصدّر `register<Name>(server: McpServer): void`.
2. أضف الاسم إلى `TOOL_NAMES` **وأضف الاستدعاء** في `registerAllTools` داخل
   `src/server/registerTools.ts` — القائمة هي المصدر الوحيد للحقيقة.
3. أضف الأداة إلى `manifest.json` بالوصف نفسه؛ `npm run check:manifest` يفشل عند أي انحراف.
4. اختبار تكامل في `tests/integration/tools.test.ts` أو ملف جديد بجواره.

## المخطط والاستجابة

استعمل مساعدات `src/tools/shared.ts` ولا تعد اختراعها:

- `outputSchema({...})` — يضيف `ok` (مطلوب) و`error` (اختياري)، ويجعل حقول النجاح اختيارية
  مع `.passthrough()`. السبب: عملاء MCP يتحققون من `structuredContent` حتى في الأخطاء، فالمخطط
  الصارم يحوّل كل خطأ مكتوب إلى فشل بروتوكول.
- `zError` / `toStructuredError` (`src/util/errors.ts`) — كل خطأ يحمل `code` و`message_ar` و`message_en`.
  ارمِ `Fiqh4Error` بكود واضح بدل `throw new Error`.
- `zBatch` — غلاف الدفعات: `total_hits, returned, has_more, next_cursor, truncated, truncation_reason`.
  أي أداة تُرجع قائمة قابلة للنمو **يجب** أن تستعمله. `truncation_reason ∈ {none,
  max_results_per_response, byte_budget, time_budget, book_limit}`.
- `zMadhhab` / `zMatchMode` مشتقان من `MADHHAB_VALUES` و`MATCH_MODES` — لا تكرر القيم نصًا.
- الكائنات المتداخلة `.passthrough()` حتى لا يكسر حقل وصفي جديد بحثًا جاريًا.

كل استجابة = ملخص عربي قصير في `content` + الحمولة في `structuredContent`.

## محاذير

- لا تُدخل حقلًا يمكن أن يحمل ترجيحًا أو حكمًا أو إجماعًا في مخرجات `compare_issue` — اختبار يمنعه.
- ما لا تسجّله الشاملة يُعاد `null` صراحةً (طبعة، رقم صفحة) — لا قيمة مخترعة ولا حذف الحقل.
- الاقتباس من `text_original` فقط.
- بعد أي تغيير في السطح: `npm run check:manifest && npm run smoke`.
