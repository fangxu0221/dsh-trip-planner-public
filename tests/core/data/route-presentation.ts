/** 站内换乘和出站步行的对照样本，使用公开站名及模拟线路数据。 */
const walk = (distance: string, duration: string, instruction: string) => ({
  distance, duration, steps: [{ distance, duration, instruction }],
})
const metro = (name: string, from: string, to: string) => ({
  buslines: [{ name, type: '地铁线路', departure_stop: { name: from }, arrival_stop: { name: to }, via_stops: [], duration: '2160' }],
})

export const transitPresentationFixture = {
  transits: [
    {
      duration: '4080',
      segments: [
        { walking: walk('320', '300', '沿起点路步行至坑口站'), bus: metro('1号线(起始站--第一末站)', '坑口站', '测试换乘站') },
        { walking: walk('80', '120', '沿换乘通道步行至11号线站台'), bus: metro('11号线(起始站--第二末站)', '测试换乘站', '天河公园站'),
          exit: { name: 'A口' } },
        { walking: walk('240', '180', '沿终点路步行至天河公园') },
      ],
    },
    {
      duration: '4800',
      segments: [
        { bus: metro('1号线', '坑口站', '测试换乘站'), exit: { name: 'B口' } },
        { walking: walk('360', '300', '从B口出站后过马路，前往另一处地铁入口'),
          bus: metro('11号线', '测试换乘站', '天河公园站'), entrance: { name: 'C口' } },
      ],
    },
    {
      duration: '4920',
      segments: [
        { bus: { buslines: [
          { name: '18路(起始站--测试总站)', type: '普通公交线路', departure_stop: { name: '公交始发站' },
            arrival_stop: { name: '测试换乘站' }, via_num: 2, duration: '840' },
          { name: '20路(起始站--测试总站)', type: '普通公交线路', departure_stop: { name: '公交始发站' },
            arrival_stop: { name: '测试换乘站' }, via_num: 2, duration: '900' },
        ] } },
        { bus: { buslines: [
          { name: '广佛线(起始站--测试终点站)', departure_stop: { name: '测试换乘站' },
            arrival_stop: { name: '地铁下车站' }, via_num: 8, duration: '1500' },
        ] } },
      ],
    },
  ],
}
