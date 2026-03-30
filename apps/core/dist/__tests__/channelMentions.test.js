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
    it('忽略引号中的 @agent', () => {
        const result = findMentionedAgents('你刚才说“@Tab 你好”，这里不是在重新点名。', agents);
        expect(result).toEqual([]);
    });
    it('忽略代码块中的 @agent', () => {
        const result = findMentionedAgents('请看这个例子：```md\n@Bob review this\n``` 但先别真的叫他。', agents);
        expect(result).toEqual([]);
    });
    it('忽略行内代码中的 @agent', () => {
        const result = findMentionedAgents('我刚才执行了 `echo @alice_1`，这里只是展示命令。', agents);
        expect(result).toEqual([]);
    });
    it('忽略引用块中的 @agent', () => {
        const result = findMentionedAgents('> @Bob 帮我看一下\n\n上面是在引用旧消息。', agents);
        expect(result).toEqual([]);
    });
    it('仍识别忽略区块外的显式 @agent', () => {
        const result = findMentionedAgents('你刚才说“@Tab 你好”，但现在还是请 @Bob 看一下。', agents);
        expect(result.map((agent) => agent.name)).toEqual(['Bob']);
    });
});
