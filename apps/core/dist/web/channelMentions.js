export function findMentionedAgents(content, agents) {
    const mentionRegex = /@([a-zA-Z0-9_-]+)/g;
    const mentioned = new Set();
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
        mentioned.add(match[1].toLowerCase());
    }
    if (mentioned.size === 0)
        return [];
    return agents.filter((agent) => mentioned.has(agent.name.toLowerCase()));
}
