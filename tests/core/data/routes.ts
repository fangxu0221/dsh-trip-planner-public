/** 仅供离线测试的路线样本，不参与生产查询。字段结构参考高德文档，数值不代表真实导航。 */
export const routeFixtures = {
  walking: { route: { paths: [{ distance: '1200', duration: '960', steps: [{ instruction: '沿测试路步行', distance: '1200', duration: '960' }] }] } },
  bicycling: { data: { paths: [{ distance: 1400, duration: 420, steps: [{ instruction: '沿测试路骑行', distance: 1400, duration: 420 }] }] } },
  driving: { route: { paths: [{ distance: '2000', duration: '600', tolls: '0', steps: [{ instruction: '沿测试路行驶', distance: '2000', duration: '600' }] }] } },
  transit: { route: { distance: '99999', transits: [{ duration: '1800', cost: '2', walking_distance: '200', segments: [
    { walking: { distance: '100', duration: '80', steps: [{ instruction: '步行至甲站', distance: '100', duration: '80' }] },
      bus: { buslines: [
        { name: '测试地铁一号线', type: '地铁线路', departure_stop: { name: '甲站' }, arrival_stop: { name: '乙站' }, distance: '3000', duration: '900' },
        { name: '测试公交 8 路', type: '普通公交', departure_stop: { name: '甲站' }, arrival_stop: { name: '乙站' }, distance: '3500', duration: '1000' },
      ] }, entrance: { name: 'A口' }, exit: { name: 'B口' }, railway: { name: '', trip: '' } },
    { walking: { distance: '100', duration: '80', steps: [{ instruction: '步行至终点' }] }, bus: { buslines: [] }, railway: { name: '', trip: '' } },
  ] }] } },
} as const
