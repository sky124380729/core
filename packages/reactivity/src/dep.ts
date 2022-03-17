import { ReactiveEffect, trackOpBit } from './effect'

export type Dep = Set<ReactiveEffect> & TrackedMarkers

/**
 * wasTracked and newTracked maintain the status for several levels of effect
 * tracking recursion. One bit per level is used to define whether the dependency
 * was/is tracked.
 */
type TrackedMarkers = {
  /**
   * wasTracked 代表副作用函数执行前被 track 过
   */
  w: number
  /**
   * newTracked 代表副作用函数执行后被 track
   */
  n: number
}

export const createDep = (effects?: ReactiveEffect[]): Dep => {
  const dep = new Set<ReactiveEffect>(effects) as Dep
  dep.w = 0
  dep.n = 0
  return dep
}

export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0

export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0

export const initDepMarkers = ({ deps }: ReactiveEffect) => {
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].w |= trackOpBit // set was tracked
    }
  }
}

export const finalizeDepMarkers = (effect: ReactiveEffect) => {
  const { deps } = effect
  if (deps.length) {
    let ptr = 0
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i]
      //有 was 标记但是没有 new 标记，应当删除
      if (wasTracked(dep) && !newTracked(dep)) {
        dep.delete(effect)
      } else {
        // 需要保留的依赖，放到数据的较前位置，因为在最后会删除较后位置的所有依赖
        deps[ptr++] = dep
      }
      // 清理 was 和 new 标记，将它们对应深度的 bit，置为 0
      // clear bits
      dep.w &= ~trackOpBit
      dep.n &= ~trackOpBit
    }
    // 删除依赖，只保留需要的
    deps.length = ptr
  }
}
