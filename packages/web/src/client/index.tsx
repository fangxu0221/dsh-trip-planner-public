/** 组装入口：注册会话右栏页面，收藏状态跨会话共享。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import contribution from '../../lib/typert.remote-client.js'
import { TripClientModel, TripQueries } from './model.ts'
import { TripPanel, type TripPanelInjected } from './TripPanel.tsx'
import { styles } from './styles.ts'

const panelId = 'trip-planner'
export const inject = ['remote', 'slots']

function TripIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="5" cy="18" r="2" /><circle cx="19" cy="6" r="2" />
    <path d="M7 18h8a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h8" />
  </svg>
}

const ui = {
  name: 'trip-planner-ui', inject: ['remote.tripPlanner', 'slots', 'sidebarRightTabs'],
  apply(ctx: Context): void {
    const model = new TripClientModel(ctx.remote.tripPlanner, options => ctx.remote.$stream(options))
    const panel: TripPanelInjected = {
      hooks: { trip: model.state },
      createQueries: () => new TripQueries(ctx.remote.tripPlanner),
      onConnectFavorites: () => model.connectFavorites(),
      onSavePlace: request => model.savePlace(request),
      onRenameSavedPlace: request => model.renameSavedPlace(request),
      onRemoveSavedPlace: target => model.removeSavedPlace(target),
    }
    void model.connectFavorites()
    ctx.effect(() => () => model.dispose())
    ctx.effect(() => {
      const style = document.createElement('style')
      style.textContent = styles
      document.head.append(style)
      return () => style.remove()
    })
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: panelId, kind: panelId, keepMounted: true, title: () => '出行规划',
      guide: [{ id: panelId, order: 30, title: () => '出行规划', description: () => '搜索地点、选用收藏并规划路线', icon: TripIcon }],
    }))
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: panelId, inject: () => panel }, TripPanel,
    )))
  },
}

export async function apply(ctx: Context): Promise<void> {
  const unmount = await ctx.remote.$mount(contribution)
  ctx.effect(() => () => unmount())
  await ctx.plugin(ui)
}
