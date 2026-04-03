• 有一个更关键的发现：我们现在给 claude-code-acp 传的是字符串 systemPrompt，而这个适配器的代码会把默认的 preset: "claude_code" 直接替换掉，不
  是追加。也就是说，当前我们的 claude_acp 接入很可能没有保留 Claude Code 那层内置 preset。

• Searched https://docs.anthropic.com/en/docs/claude-code/settings

• Searched site:docs.anthropic.com "internal system prompt" "Claude Code"

─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

• 我查了官方文档和本地 claude-code-acp 代码，结论是：

  1. Claude Code 确实有“内部 system prompt / preset”这一层，但官方不公开正文。
  Anthropic 官方文档明确说，Claude Code 的内部 system prompt 不会公开；官方建议用 CLAUDE.md 或 --append-system-prompt 来追加自定义指令。来
  源：

  - https://docs.anthropic.com/en/docs/claude-code/settings
  - https://docs.anthropic.com/s/claude-code-sdk

  2. 我们现在看不到它，不只是 transcript 没暴露，还有一个更关键的问题：我们当前接法很可能把这层 preset 覆盖掉了。
  claude-code-acp 默认会把 system prompt 设成内部 preset claude_code，见 /root/.npm/_npx/4c83e1a162637933/node_modules/@zed-industries/
  claude-code-acp/dist/acp-agent.js:756。
  但如果 _meta.systemPrompt 是字符串，它就直接 systemPrompt = customPrompt；只有传 { append: "..." } 才是追加，见同文件 /root/.npm/
  _npx/4c83e1a162637933/node_modules/@zed-industries/claude-code-acp/dist/acp-agent.js:757。

  3. 而我们当前传的是字符串，不是 append。
  在 packages/runtime-acp/src/gateway/bindingRuntime.ts:408，我们创建 session 时传的是：
  _meta: { systemPrompt: systemPromptText.trim() }
  这意味着对 claude-code-acp 来说，更像是“替换默认 preset”，不是“在 Claude Code 内置 prompt 后追加”。

  4. 这也解释了为什么 Claude/Kimi 的 debug 里看不到类似 Codex base_instructions 的东西。
  Claude transcript 里目前只有 user/assistant/tool 记录，没有类似 Codex session_meta.base_instructions 的字段；我们的 parser 也只能拿到这些，
  见 apps/core/src/services/claudeTranscriptService.ts:216。
  所以现在是两层叠加：

  - transcript 本身不暴露内部 prompt
  - 我们当前接法还可能把默认 preset 覆盖了

  结论

  - Claude Code 不是“没有内置 system prompt”
  - 是“官方不公开正文，transcript 也不暴露”
  - 更重要的是：我们当前 claude_acp 集成很可能没有保留 Claude Code 的默认 claude_code preset

  如果你要，下一步我建议直接改一版：

  - 对 claude_acp 不再传字符串 systemPrompt
  - 改成传 { append: systemPromptText }
    这样更符合 Anthropic 官方“append 自定义指令”的用法，也更可能保留 Claude Code 自带的内部 preset。
