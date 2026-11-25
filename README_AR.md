# AgentOS v0.1.0 — Windows + Firefox

حزمة أولية قابلة للتشغيل لإضافة Firefox ومحرك Windows محلي. تتضمن:

- Firefox WebExtension Manifest V3 مع لوحة جانبية.
- Native Messaging Host لمحرك Windows (Python، ثم PyInstaller EXE).
- بروتوكول JSON موحد ومحدد للأوامر.
- إدارة Agent Skills وفق تنسيق `SKILL.md` المفتوح.
- مدير Plugins ببيانات وصفية ومراجعة/تفعيل صريح.
- إعدادات MCP وإمكانية استعراض الأدوات واستدعاء الأدوات المسموح بها عبر stdio.
- مساحة عمل محلية مقيدة داخل `workspace`.
- سجل عمليات، وإيقاف طارئ، وقائمة سماح للأوامر الحساسة.

> **حدود v0.1:** لا يوجد اتصال API بنموذج. الإضافة لا تستطيع جعل ChatGPT/Claude/Gemini يرسل أدوات تلقائياً لمجرد فتح الموقع. في هذا الإصدار يقرأ المستخدم رد الموقع ويُلصق كتلة JSON من نوع `agentos.v1` في لوحة AgentOS، أو يستخدم زر التقاط الصفحة. يمكن لاحقاً تطوير موصلات واجهة لكل موقع، لكنها هشة وتتطلب اختباراً عند تغير تصميم المواقع.

## متطلبات

- Windows 10/11 64-bit
- Firefox حديث يدعم WebExtensions MV3 و `sidebar_action`
- Python 3.11 أو أحدث (للتطوير والبناء)
- Node.js غير مطلوب لهذه النسخة؛ ملفات الإضافة جاهزة دون build step
- Git (لاستيراد المهارات والمكونات من GitHub)

## تثبيت سريع

1. فك الضغط إلى `D:\AgentOS`.
2. افتح PowerShell داخل `D:\AgentOS`.
3. شغّل:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup.ps1
```

4. افتح Firefox ثم `about:debugging#/runtime/this-firefox`.
5. اختر **Load Temporary Add-on** وحدد `D:\AgentOS\extension\manifest.json`.
6. اضغط أيقونة AgentOS أو افتح القائمة الجانبية من Firefox.

الإضافة تعمل مؤقتاً حتى إعادة تشغيل Firefox؛ للتوزيع الدائم يلزم توقيع AMO أو تثبيت مؤسسي مناسب.

## بناء وتسجيل Native Host

```powershell
.\scripts\build-host.ps1
.\scripts\install-host.ps1
```

ثم أعد تحميل الإضافة وافتح لوحة AgentOS واضغط **اختبار اتصال Windows**.

## تشغيل اختبارات المحرك

```powershell
.\.venv\Scripts\Activate.ps1
python -m unittest discover -s runtime\tests -v
```

## المهارات Skills

المجلد الافتراضي: `D:\AgentOS\skills`

```powershell
python runtime\agentos_cli.py skills list
python runtime\agentos_cli.py skills install-github https://github.com/OWNER/REPO
```

يدعم المستورد مستودعات Git التي تحتوي مجلدات بها `SKILL.md`. لا يتم تشغيل سكربتات المهارة تلقائياً. اقرأ `SKILL.md` وراجع أي scripts قبل استخدامها.

المعيار: [Agent Skills](https://github.com/agentskills/agentskills).

## Plugins

ضع مجلد كل إضافة داخل `D:\AgentOS\plugins` مع `plugin.json`. يمكن استيراد الإضافات من GitHub عبر CLI. الإضافات الخارجية غير موثوقة افتراضياً ولا يتم تشغيلها تلقائياً. بعد مراجعة الكود، استخدم أوامر trust ثم enable. تذكر أن Python plugin يعمل بصلاحيات حساب Windows، ولا يوجد sandbox حقيقي له في v0.1.

```powershell
python runtime\agentos_cli.py plugins list
python runtime\agentos_cli.py plugins inspect example-hello
python runtime\agentos_cli.py plugins install-github OWNER/REPO
# بعد مراجعة كود الإضافة فقط:
python runtime\agentos_cli.py plugins trust PLUGIN_ID
python runtime\agentos_cli.py plugins enable PLUGIN_ID
```

## مصادر GitHub المقترحة للمهارات

- `https://github.com/agentskills/agentskills` — المواصفة المفتوحة وأدوات التحقق من تنسيق المهارات.
- `https://github.com/anthropics/skills` — مجموعة مهارات وأمثلة.
- `https://github.com/openai/skills` — مجموعة مهارات وأمثلة لـ Codex.

مثال استيراد مستودع مهارات: `python runtime\agentos_cli.py skills install-github anthropics/skills`. قد يحتوي المستودع على عدة مهارات؛ راجع كل مهارة ومحتوياتها قبل استخدامها. لا يتم تشغيل scripts تلقائياً.

## MCP

إعداد الخدمات في `D:\AgentOS\config\mcp_servers.json`. يدعم هذا الإصدار خوادم MCP المحلية عبر `stdio` مع بروتوكول JSON-RPC، ويتيح `tools/list` و`tools/call` للأدوات المسموح بها فقط. يمكن للوكيل طلب `mcp.tools` و`mcp.call` بعد ضبط allowlist.

1. انسخ `config\mcp_servers.example.json` إلى `config\mcp_servers.json`.
2. عدّل `command`, `args`, `enabled`, و`allowed_tools` لخادم تثق به.
3. لتجربة خادم MCP التجريبي، ثبّت الاعتمادية الاختيارية: `python -m pip install -r requirements-mcp.txt` ثم أضف إعداداً مثل:

```json
{
  "servers": {
    "agentos-demo": {
      "description": "AgentOS demo MCP server",
      "enabled": true,
      "command": "D:\\AgentOS\\.venv\\Scripts\\python.exe",
      "args": ["D:\\AgentOS\\examples\\mcp_demo_server.py"],
      "allowed_tools": ["echo", "add"]
    }
  }
}
```

4. اعرض الخدمات والأدوات:

```powershell
python runtime\agentos_cli.py mcp list
python runtime\agentos_cli.py mcp tools agentos-demo
```

لا تضف خادماً من الإنترنت أو GitHub قبل مراجعة مصدره وأوامره. خادم MCP يعمل بصلاحيات حساب Windows الذي يشغله.

## بروتوكول AgentOS

في لوحة الإضافة الصق كتلة مثل:

```json
{
  "protocol": "agentos.v1",
  "type": "action",
  "action": "workspace.create_file",
  "arguments": {"path": "notes/hello.txt", "content": "Hello from AgentOS"}
}
```

الأوامر المدعومة افتراضياً: `runtime.status`, `skills.list`, `plugins.list`, `mcp.list`, `workspace.list`, `workspace.read_file`, `workspace.create_file`, `browser.open_url`.

`browser.open_url` ينفذ داخل Firefox بعد تحقق الإضافة من أن الرابط http/https. تتوفر `skills.read` و`plugins.call` و`mcp.tools` و`mcp.call` مع ضوابط التفعيل والثقة وقائمة السماح. لا يوجد `terminal.execute` أو تنفيذ أوامر PowerShell اعتباطية في هذه النسخة.

## الأمان

- كل عمليات الملفات محصورة داخل `D:\AgentOS\workspace` مع منع traversal والروابط الرمزية خارج المساحة.
- لا يوجد shell عام في v0.1.
- MCP معطل افتراضياً، واستدعاء الأدوات يتطلب `allowed_tools`.
- لا يتم تشغيل مهارات أو Plugins من GitHub تلقائياً.
- سجل الأحداث في `logs\agentos.log`.
- زر Stop يوقف استقبال الأوامر الجديدة من الواجهة؛ لا يمكن ضمان قتل عملية خارجية بدأت بالفعل في خادم MCP.

## بنية المشروع

```text
AgentOS/
  extension/        Firefox add-on
  runtime/          Python Native Host + CLI + tests
  skills/           Imported Agent Skills
  plugins/          Plugins and manifests
  config/           MCP and runtime configuration
  protocol/         JSON schemas and examples
  workspace/        Sandboxed file workspace
  logs/             Audit log
  scripts/          Windows setup/build/install scripts
```

## التراخيص

كود AgentOS في هذه الحزمة مرخص MIT. مواصفات Agent Skills وMCP والمكونات الخارجية تحت تراخيص أصحابها؛ راجع مستودع كل مشروع قبل إعادة التوزيع.
