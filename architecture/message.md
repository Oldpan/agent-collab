三种消息路径                                                                                                                                  
                                                                                                                                                
  1. DM（私聊）                                                                                                                                 
                                                                                                                                                
  触发入口：浏览器 WebSocket → wsHandler.ts chat.message 事件                                                                                   
                                               
  wsHandler.ts                                                                                                                                  
    └─ manager.submitPrompt(conversationId, text)                                      
         └─ executionDispatcher.dispatchPrompt()                                                                                                
              recordAsUserMessage = true（默认）                                                                                                
              ├─ 消息写入 channel_messages（dm:{agentId}）                                                                                      
              ├─ promptText = buildDirectActivationPrompt({                                                                                     
              │    agentName, senderName, replyTarget: "dm:@User", content                                                                      
              │  })                                                                                                                             
              └─ dispatchedPrompt = prependTurnReplyContract(promptText)                                                                        
                   → RunDispatchMsg → node → ACP                                                                                                
                                                                                                                                                
  最终 prompt 结构：                                                                                                                            
  [Reply contract]                                                                                                                              
  ...                                                                                                                                           
                                                                                       
  [System: User sent you a direct message.]    
  Do not call check_messages just to retrieve this same message again.                                                                          
  If you need more context, call read_history(channel="dm:@User")     
                                                                                                                                                
  [Triggered message metadata]                                                                                                                  
  target: dm:@User                                                                                                                              
  recipient: @AgentName                                                                                                                         
  sender: @User                                                                        
                                                                                                                                                
  [Triggered message body]
  <用户原始消息>                                                                                                                                
                                                                                       
  ---                                          
  2. Channel @mention
                                                                                                                                                
  触发入口：浏览器 POST /api/channels/:id/messages（REST）
                                                                                                                                                
  server.ts  POST /api/channels/:id/messages                                           
    ├─ 消息写入 channel_messages（target="#general"）                                                                                           
    ├─ findMentionedAgents(content) → 找到被 @的 agent 列表                                                                                     
    └─ for each mentioned agent:                                                                                                                
         ├─ openAgentChannelThread(agentId, channelId, null) → 获取/创建 conversation                                                           
         ├─ buildTargetActivationContext() → 加载近 8 条同 target 历史消息 + unread count                                                       
         └─ submitPrompt(conv.id, buildChannelActivationPrompt({                                                                                
              channelName, target: "#general",                                                                                                  
              replyTarget: "#general"（或从 conv 取），                                                                                         
              senderName, content,                                                                                                              
              reason: 'mention',                                                                                                                
              recentMessages,  ← 近 8 条                                                                                                        
              unreadCount,                                                                                                                      
            }), { recordAsUserMessage: false })                                        
                 └─ dispatchPrompt()  recordAsUserMessage=false → 不重复存消息，不走 directActivationPrompt                                     
                      └─ prependTurnReplyContract(channelPrompt) → node → ACP                                                                   
                                                                                                                                                
  最终 prompt 结构：                                                                                                                            
  [Reply contract]                                                                                                                              
  ...                                                                                  
                                               
  [System: You were @mentioned in #general by User.]
  The triggering message is included below...                                                                                                   
  This execution is bound to reply_target="#general". Prefer mcp__chat__send_message(...) with no target.
  If you need more context, call read_history(channel="#general")                                                                               
  Reply only via mcp__chat__send_message(...)                                                                                                   
  If you are doing channel work, ordinary progress updates can be plain channel replies...                                                      
                                                                                                                                                
  [Current conversation target]                                                                                                                 
  reply_target: #general                                                                                                                        
                                                                                                                                                
  [Recent messages on this exact target]     ← 近 8 条上文                             
  [Message metadata] target: #general ...                                                                                                       
  [Message body] ...                     
                                                                                                                                                
  [Triggered message metadata]                                                         
  target: #general                                                                                                                              
  sender: @User                                                                        
                                               
  [Triggered message body]
  <消息内容>                                                                                                                                    
   
  ---                                                                                                                                           
  3. Channel Thread 回复                                                               
                                               
  触发入口：POST /api/channels/:id/messages 带 replyTo: <threadRootId>
                                                                                                                                                
  server.ts  POST /api/channels/:id/messages  (replyTo 有值)
    ├─ 消息写入 channel_messages（thread_root_id = threadRootId, target="#general:abc123"）                                                     
    ├─ 查 root 消息：sender_type === 'agent' ?                                                                                                  
    └─ openAgentChannelThread(agentId, channelId, threadRootId) → thread 专属 conversation                                                      
         ├─ buildTargetActivationContext({ threadRootId }) →                                                                                    
         │    recentMessages: 近 8 条 thread_root_id=xxx 的消息                                                                                 
         │    rootMessage: thread 根消息                                                                                                        
         │    unreadCount: 未读数                                                                                                               
         └─ submitPrompt(conv.id, buildChannelActivationPrompt({                                                                                
              channelName, target: "#general:abc123",                                                                                           
              replyTarget: "#general:abc123",                                          
              senderName, content,                                                                                                              
              reason: 'thread_reply',                                                  
              rootMessage,      ← thread 根消息
              recentMessages,   ← 近 8 条 thread 内消息                                                                                         
              unreadCount,
            }), { recordAsUserMessage: false })                                                                                                 
                 └─ prependTurnReplyContract(channelPrompt) → node → ACP                                                                        
                                               
  最终 prompt 结构（比 mention 多了 [Thread root message]）：                                                                                   
  [Reply contract]                                                                     
  ...                                                                                                                                           
                                                                                       
  [System: Your message in #general received a reply from User.]
  ...                                                                                                                                           
  This execution is bound to reply_target="#general:abc123".
                                                                                                                                                
  [Current conversation target]                                                        
  reply_target: #general:abc123                
                               
  [Thread root message]         ← 仅 thread 路径有                                                                                              
  [Message metadata] target: #general:abc123 ...  
  [Message body] <thread 根消息内容>                                                                                                            
                                                                                                                                                
  [Recent messages on this exact target]       
  ...（thread 内近 8 条）                                                                                                                       
                                                                                       
  [Triggered message metadata]                                                                                                                  
  target: #general:abc123     
  sender: @User                                                                                                                                 
                                                                                       
  [Triggered message body]                     
  <用户回复内容>          

  ---                                                                                                                                           
  三条路径对比
                                                                                                                                                
  ┌─────────────┬───────────────────────────┬────────────────────────────────────────────┬─────────────────────────────────────────────────┐
  │             │            DM             │              Channel @mention              │                 Channel Thread                  │    
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ 触发方式    │ WebSocket chat.message    │ REST POST (含@)                            │ REST POST (含 replyTo)                          │    
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ 消息持久化  │ dispatcher 内写入         │ server.ts 写，dispatcher 不再写            │ server.ts 写，dispatcher 不再写                 │    
  │             │ dm:{agentId}              │                                            │                                                 │    
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤    
  │ Prompt 构建 │ buildDirectActivationProm │ buildChannelActivationPrompt(reason:'menti │ buildChannelActivationPrompt(reason:'thread_rep │    
  │             │ pt                        │ on')                                       │ ly')                                            │
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤    
  │ 含近期历史  │ 否（靠 read_history       │ 是（8 条）                                 │ 是（8 条 thread 内）                            │
  │             │ 主动拉）                  │                                            │                                                 │    
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ 含 root     │ —                         │ —                                          │ 是                                              │    
  │ 消息        │                           │                                            │                                                 │    
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ reply_targe │ dm:@User                  │ #general                                   │ #general:threadId                               │    
  │ t           │                           │                                            │                                                 │    
  ├─────────────┼───────────────────────────┼────────────────────────────────────────────┼─────────────────────────────────────────────────┤
  │ conversatio │ 单个主 DM conversation    │ 每 agent × channel 一个                    │ 每 agent × channel × threadRootId 一个          │    
  │ n 粒度      │                           │                                            │                                                 │    
  └─────────────┴───────────────────────────┴────────────────────────────────────────────┴─────────────────────────────────────────────────┘
                                                                                                                                                
  ---                                                                                  
  Agent 回复怎么走                             
                                                                                                                                                
  Agent 通过 ACP 内的 mcp__chat__send_message 调用，这个 MCP 工具最终 HTTP POST 到 POST 
  /api/internal/agent/:agentId/send（internalAgentRouter.ts），core 再把消息写入 channel_messages 并通过 WS broadcastToChannel/broadcastToAgent 
  推送给前端。  






                                                                                                                                                 
  第1轮 (cold_start)：                                                                                                                         
    ACP newSession({ systemPrompt }) ← systemPromptText 真正被用                       
    content blocks: [contextText, prompt1]  ← MEMORY.md + 激活 prompt 进入 context                                                             
                                                                                                                                               
  第2轮 (resume, ACP session 还活着)：                                                                                                         
    ACP session id 已存在 → systemPromptText 被忽略（session 已建好）                                                                          
    isFreshSession = false → contextText 不注入                                                                                                
    content blocks: [prompt2 only]  ← 只有当轮激活 prompt 进入 context                                                                         
                                                                                                                                               
  第3轮 (resume, ACP session 还活着)：                                                                                                         
    content blocks: [prompt3 only]                                                                                                             
    模型 context 里已有：system prompt + MEMORY.md + prompt1 + 回复1 + prompt2 + 回复2 