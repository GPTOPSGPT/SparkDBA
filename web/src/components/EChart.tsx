import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import type { EChartsCoreOption } from 'echarts/core'

echarts.use([BarChart, LineChart, GridComponent, LegendComponent, TooltipComponent, SVGRenderer])

const chartTheme = {
  textStyle: { color: '#8a8f98', fontFamily: 'inherit' },
  legend: { textStyle: { color: '#e9eaee' } },
  tooltip: { backgroundColor: '#17181c', borderColor: '#2c2d33', textStyle: { color: '#e9eaee' } },
}

export function EChart({ option, height = 240 }: { option: EChartsCoreOption; height?: number }) {
  const el = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: 'svg' })
    chart.current = c
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(el.current!)
    return () => { ro.disconnect(); c.dispose() }
  }, [])
  useEffect(() => { chart.current?.setOption({ ...chartTheme, ...option }) }, [option])
  return <div ref={el} style={{ height, width: '100%' }} />
}
