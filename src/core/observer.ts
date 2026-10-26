// observer.ts — MutationObserver 重放驱动。
// 契约: 监听 adapter 的日志容器; 行被虚拟化重建/step 重渲染/懒加载展开后,
//       把累积的 mutation 批次回调 controller 重放注入 (状态外置, 注入幂等,
//       重放零成本跳过已注入行; 增量 sync 只扫批次涉及的新节点)。
// 观察面: childList + subtree (forgejo: 懒加载 append; github: 虚拟化 attach/detach
//       + step 重渲染整池重建)。debounce 吸收批量 DOM 变更, 窗口内批次累积不可丢。

export class ReplayDriver {
  private observer: MutationObserver | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: MutationRecord[] = []

  constructor(
    private readonly onReplay: (batch: MutationRecord[]) => void,
    private readonly debounceMs = 120,
  ) {}

  start(rootEl: Element): void {
    this.stop()
    this.observer = new MutationObserver((muts) => {
      this.pending.push(...muts)
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        const batch = this.pending
        this.pending = []
        this.onReplay(batch)
      }, this.debounceMs)
    })
    this.observer.observe(rootEl, { childList: true, subtree: true })
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = []
    this.observer?.disconnect()
    this.observer = null
  }
}
