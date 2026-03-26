import { describe, expect, it } from 'vitest';
import { findMentionedAgents } from '../web/channelMentions.js';
describe('findMentionedAgents', () => {
    const agents = [
        { agentId: 'a1', name: 'Tab' },
        { agentId: 'a2', name: 'Bob' },
        { agentId: 'a3', name: 'alice_1' },
    ];
    it('只返回被 @ 的频道 agent', () => {
        const result = findMentionedAgents('@Tab 帮我看一下这个问题', agents);
        expect(result.map((agent) => agent.name)).toEqual(['Tab']);
    });
    it('支持一次消息中 @ 多个 agent', () => {
        const result = findMentionedAgents('@Tab 和 @Bob 一起看看', agents);
        expect(result.map((agent) => agent.name)).toEqual(['Tab', 'Bob']);
    });
    it('大小写不敏感', () => {
        const result = findMentionedAgents('@tab 请处理', agents);
        expect(result.map((agent) => agent.name)).toEqual(['Tab']);
    });
    it('未 @ 任何 agent 时返回空数组', () => {
        const result = findMentionedAgents('大家看看这个问题', agents);
        expect(result).toEqual([]);
    });
    it('不会返回未加入频道的名字', () => {
        const result = findMentionedAgents('@Charlie 处理一下', agents);
        expect(result).toEqual([]);
    });
});
