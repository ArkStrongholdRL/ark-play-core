import {z} from 'zod';
import {GameClient} from './rpc.mjs';
import {render} from './compact.mjs';
export {z};

const uid=z.number().int().positive(), index=z.number().int().nonnegative();
const action=z.discriminatedUnion('type',[
  z.object({type:z.literal('confirm')}),z.object({type:z.literal('band'),bandId:z.string().min(1).max(100)}),
  z.object({type:z.literal('choice'),idx:index}),z.object({type:z.literal('buy'),slot:index}),
  z.object({type:z.literal('reward'),idx:index}),
  ...['refresh','freeze','levelUp'].map(t=>z.object({type:z.literal(t)})),
  ...['sell','destroy'].map(t=>z.object({type:z.literal(t),uid})),
  z.object({type:z.literal('equip'),itemUid:uid,targetUid:uid,replaceUid:uid.nullable().optional()}),
  z.object({type:z.literal('art'),itemUid:uid,row:index,col:index,dir:z.enum(['RIGHT','LEFT','UP','DOWN']).optional()}),
  z.object({type:z.literal('move'),uid,to:z.discriminatedUnion('area',[
    z.object({area:z.literal('board'),row:index,col:index}),z.object({area:z.literal('hand'),idx:index})]),
    dir:z.enum(['RIGHT','LEFT','UP','DOWN']).optional()}),
  z.object({type:z.literal('ready'),ready:z.literal(true).optional()}),
]);

export const INSTRUCTIONS='Play only on user request. ark_start joins the configured game site over its native /ws protocol and starts solo play, or joins a specified room and readies up for its host. Gameplay calls stay pending while waiting for the host, teammates, another player turn, combat or site resume; WS events wake the same call only when a player decision, terminal result or error is available. Do not poll, sleep then repeatedly call ark_view, or repeat ark_start while waiting. Read the compact view and submit explicit actions with the latest local snapshot revision and a short purpose. The revision is a client precondition, not a server atomic lock. The server can reject stale choices or illegal targets. Batches stop on rejection or phase/round changes and never continue into another round. After ready, the plugin computes and reports combat internally and returns the next player decision or terminal result. ark_view also waits for a decision when recovering an uncertain action. Cancellation or disconnection does not undo accepted actions; recover once with ark_view before issuing another action. A closed room ends the wait and must not be automatically rejoined. After each settled round and before the next decision, call ark_combat once to review damage, damage taken, healing and shares. Do not poll it during combat. Missing or partial local metrics are not zero performance; interpret them alongside the current board and enemy preview. Native battle simulation is isolated from model observations; only completed-round summary counters are exposed. The site owns authentication, pacing, recording and persistence. This plugin never collects or downloads trajectories.';

export function createTools(config={}) {
  const client=new GameClient(config);let previous=null;
  const show=(reply,full=false)=>{
    const text=(reply.error ? `错误: ${reply.error}；没有执行任何动作。\n` : '')+render(reply,previous,full);
    if(reply.view)previous=reply.view;
    return {text};
  };
  const tools=[
    {name:'ark_start',description:'开单人局，或按 roomCode 加入已有房间并准备。等待房主开始、队友及自己的决策时机时，本次调用保持挂起，由 WS 事件唤醒后返回；不要轮询或重复开局。房间号留空开单人局；加入时难度由房间决定。',
      schema:z.object({difficulty:z.enum(['ABYSS','NORMAL','HARD']).default('ABYSS'),roomCode:z.string().trim().toUpperCase().regex(/^(?:[A-Z0-9]{4})?$/).optional().describe('四位房间号；省略使用客户端配置，空字符串开单人局')}),
      execute:async(args,signal)=>show(await client.call({op:'start',difficulty:args.difficulty,roomCode:args.roomCode??client.config.roomCode},signal),true)},
    {name:'ark_view',description:'恢复完整紧凑局面。联机等待、别人回合、战斗或暂停期间，本次调用保持挂起，监听 WS 直到自己的下一决策、终局或错误；无需反复调用。用于上下文丢失、断线重连或动作结果不确定。',
      schema:z.object({}),readOnly:true,execute:async(_,signal)=>show(await client.call({op:'view'},signal),true)},
    {name:'ark_act',description:'按当前本地快照revision执行1至8步明确动作。拒绝或阶段/回合改变即停止本批；需要等队友、别人回合、战斗结算或暂停恢复时，由 WS 事件驱动保持挂起，直到自己的下一决策、终局或错误才返回；不要轮询。ready 后自动处理战斗计算、上报与结算。',
      schema:z.object({revision:index,steps:z.array(z.object({action,reason:z.string().min(1).max(400)})).min(1).max(8)}),
      execute:async(args,signal)=>show(await client.call({op:'act',...args},signal))},
    {name:'ark_lookup',description:'按ID或名称查询公开卡牌、装备、盟约、策略说明；不会读取隐藏池或未来商店。',
      schema:z.object({kind:z.enum(['chess','tokens','items','bonds','bands','garrisons','bosses']),id:z.string().max(120).optional(),text:z.string().max(100).optional(),limit:z.number().int().min(1).max(8).default(3)}),
      readOnly:true,execute:async(args,signal)=>({text:JSON.stringify((await client.call({op:'lookup',query:args},signal)).result)})},
    {name:'ark_combat',description:'查询已结束上一回合（含联防）或本局已结束回合的伤害、承伤、有效治疗、DPS/HPS和玩家／干员占比。仅读取本客户端实际模拟的战场；接管、重连重建、缺失、截断明确标记。每回合结算返回后、下轮操作前调用一次；战斗中不轮询。',
      schema:z.object({scope:z.enum(['last','match']).default('last')}),readOnly:true,
      execute:async(args,signal)=>({text:JSON.stringify(await client.call({op:'combat',scope:args.scope},signal))})},
    {name:'ark_finish',description:'请求离开或结束当前对局；后续保存与处理由游戏站决定。',
      schema:z.object({}),destructive:true,execute:async(_,signal)=>({text:JSON.stringify(await client.call({op:'finish'},signal))})},
  ];
  return {client,tools,async close(){await client.close();}};
}
