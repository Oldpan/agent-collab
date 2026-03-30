function stripIgnoredMentionContexts(content) {
    let sanitized = content;
    // Ignore fenced code blocks and inline code.
    sanitized = sanitized.replace(/```[\s\S]*?```/g, ' ');
    sanitized = sanitized.replace(/~~~[\s\S]*?~~~/g, ' ');
    sanitized = sanitized.replace(/`[^`\n]*`/g, ' ');
    // Ignore markdown blockquotes.
    sanitized = sanitized.replace(/^\s*>.*$/gm, ' ');
    // Ignore common quoted spans used to quote or restate prior text.
    const quotedSpanPatterns = [
        /"[^"\n]*"/g,
        /“[^”\n]*”/g,
        /‘[^’\n]*’/g,
        /「[^」\n]*」/g,
        /『[^』\n]*』/g,
    ];
    for (const pattern of quotedSpanPatterns) {
        sanitized = sanitized.replace(pattern, ' ');
    }
    return sanitized;
}
export function findMentionedAgents(content, agents) {
    const sanitizedContent = stripIgnoredMentionContexts(content);
    const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
    const mentioned = new Set();
    let match;
    while ((match = mentionRegex.exec(sanitizedContent)) !== null) {
        mentioned.add(match[1].toLowerCase());
    }
    if (mentioned.size === 0)
        return [];
    return agents.filter((agent) => mentioned.has(agent.name.toLowerCase()));
}
