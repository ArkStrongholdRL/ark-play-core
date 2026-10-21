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

export const INSTRUCTIONS='Play only on user request. ark_start joins the configured game site over its native /ws protocol and starts solo play, or joins a specified room and readies up for its host. Read the compact view and submit explicit actions with the latest local snapshot revision and a short purpose. The revision is a client precondition, not a server atomic lock. The server can reject stale choices or illegal targets. Batches stop on rejection or phase/round changes and never continue into another round. After ready, the plugin computes and reports combat internally and returns the next player decision or terminal result; no wait tool or polling is needed. ark_view also completes pending settlement when recovering an uncertain action. Cancellation or disconnection does not undo accepted actions; recover with ark_view before issuing another action. Native battle simulation is isolated from model observations. The site owns authentication, pacing, recording and persistence. This plugin never collects or downloads trajectories.';

export function createTools(config={}) {
  const client=new GameClient(config);let previous=null;
  const show=(reply,full=false)=>{
    const text=(reply.error ? `错误: ${reply.error}；没有执行任何动作。\n` : '')+render(reply,previous,full);
    if(reply.view)previous=reply.view;
    return {text};
  };
  const tools=[
    {name:'ark_start',description:'开单人局，或按 roomCode 加入已有房间并准备，等待房主开始。房间号留空开单人局；加入时难度由房间决定。',
      schema:z.object({difficulty:z.enum(['ABYSS','NORMAL','HARD']).default('ABYSS'),roomCode:z.string().trim().toUpperCase().regex(/^(?:[A-Z0-9]{4})?$/).optional().describe('四位房间号；省略使用客户端配置，空字符串开单人局')}),
      execute:async(args,signal)=>show(await client.call({op:'start',difficulty:args.difficulty,roomCode:args.roomCode??client.config.roomCode},signal),true)},
    {name:'ark_view',description:'恢复完整紧凑局面；若正在结算，插件内部处理至下一决策或终局再返回。用于上下文丢失、断线重连或动作结果不确定。',
      schema:z.object({}),readOnly:true,execute:async(_,signal)=>show(await client.call({op:'view'},signal),true)},
    {name:'ark_act',description:'按当前本地快照revision执行1至8步明确动作。拒绝或阶段/回合改变即停止本批；ready后自动完成战斗计算、上报和结算，返回下一决策局面或终局，不需轮询。站点暂停时返回暂停提示。',
      schema:z.object({revision:index,steps:z.array(z.object({action,reason:z.string().min(1).max(400)})).min(1).max(8)}),
      execute:async(args,signal)=>show(await client.call({op:'act',...args},signal))},
    {name:'ark_lookup',description:'按ID或名称查询公开卡牌、装备、盟约、策略说明；不会读取隐藏池或未来商店。',
      schema:z.object({kind:z.enum(['chess','tokens','items','bonds','bands','garrisons','bosses']),id:z.string().max(120).optional(),text:z.string().max(100).optional(),limit:z.number().int().min(1).max(8).default(3)}),
      readOnly:true,execute:async(args,signal)=>({text:JSON.stringify((await client.call({op:'lookup',query:args},signal)).result)})},
    {name:'ark_finish',description:'请求离开或结束当前对局；后续保存与处理由游戏站决定。',
      schema:z.object({}),destructive:true,execute:async(_,signal)=>({text:JSON.stringify(await client.call({op:'finish'},signal))})},
  ];
  return {client,tools,async close(){await client.close();}};
}
