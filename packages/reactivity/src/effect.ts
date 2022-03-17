import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
// 当前 effect 的嵌套深度，每次执行会 ++effectTrackDepth
let effectTrackDepth = 0

// 位运算操作的第 trackOpBit 位
export let trackOpBit = 1

/**
 * 按位跟踪标记最多支持30级递归，即最多支持30层effect嵌套
 * 这个值是为了使现代JS能够在所有平台上使用SMI，深度受存储类型的位数限制，否则就会溢出。
 * 在JavaScript内部，数值都是以64位浮点数的形式储存，但是做位运算的时候，是以32位带符号的整数进行运算的，并且返回值也是一个32位带符号的整数。
 * 当递归超过这个深度的时候，回退使用完全清理，完全清理就是3.2之前的方案，收集依赖之前会把所有依赖都先清理掉
 * https://mp.weixin.qq.com/s/AtRNE7OINOaIKkFpJmbk4A
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')
/**
 * 如果当前深度不超过 30，使用优化方案
 * - 执行副作用函数前，给 ReactiveEffect 依赖的响应式变量，加上 was 的标记（was 是 vue 给的名称，表示过去依赖）
 * - 执行 this.fn()，track 重新收集依赖时，给 ReactiveEffect 的每个依赖，加上 new 的标记
 * - 对失效依赖进行删除（有 was 但是没有 new）
 * -恢复上一个深度的状态
 * 如果深度超过 30 ，超过部分，使用降级方案：
 * - 双向删除 ReactiveEffect 副作用对象的所有依赖（effect.deps.length = 0）
 * - 执行 this.fn()，track 重新收集依赖时
 * - 恢复上一个深度的状态
 */
export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    if (!this.active) {
      return this.fn()
    }
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      this.parent = activeEffect
      activeEffect = this
      shouldTrack = true
      // 每次执行 effect 副作用函数前，全局变量嵌套深度会自增 1，执行完成 effect 副作用函数后会自减
      trackOpBit = 1 << ++effectTrackDepth
      // 正常情况下使用优化方案，极端情况下，使用降级方案，也就是使用完全清除之前依赖的方式
      if (effectTrackDepth <= maxMarkerBits) {
        // 标记所有的dep为was
        initDepMarkers(this)
      } else {
        // 降级方案，删除所有的依赖，再重新收集依赖
        cleanupEffect(this)
      }
      // 执行过程中标记新的dep为new
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        // 对失效依赖进行删除
        finalizeDepMarkers(this)
      }
      // 恢复上一次的状态
      // 嵌套深度 effectTrackDepth 自减
      // 重置操作的位数
      trackOpBit = 1 << --effectTrackDepth
      // 恢复上一个 activeEffect
      activeEffect = this.parent
      shouldTrack = lastShouldTrack
      this.parent = undefined
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  const _effect = new ReactiveEffect(fn)
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  if (!options || !options.lazy) {
    _effect.run()
  }
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果有activeEffect的话，去执行
  if (shouldTrack && activeEffect) {
    // targetMap就是weakMap的实例
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    let dep = depsMap.get(key)
    // createDep的定义在这里，本质上其实就是个set集合
    /* export const createDep = (effects?: ReactiveEffect[]): Dep => {
      const dep = new Set<ReactiveEffect>(effects) as Dep
      dep.w = 0
      dep.n = 0
      return dep
    } */
    if (!dep) {
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined

    trackEffects(dep, eventInfo)
  }
}

export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // 是否需要收集依赖
  let shouldTrack = false
  // 如果当前副作用被递归跟踪次数小于30
  if (effectTrackDepth <= maxMarkerBits) {
    /**
     * export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0
     */
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      /**
       * export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0
       */
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    // 否则采用完全清理模式
    // 如果activeEffect没有被收集过，则应当收集
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    // 添加依赖，将effect存储到dep
    dep.add(activeEffect!)
    // 同时effect也记录一下dep
    // 用于trigger触发effect后，删除dep里面对应的effect，即dep.delete(activeEffect)
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    depsMap.forEach((dep, key) => {
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  // 循环遍历 dep，去取每个依赖的副作用对象 ReactiveEffect
  for (const effect of isArray(dep) ? dep : [...dep]) {
    /**
     * 默认不允许递归，即当前 effect 副作用函数，如果递归触发当前 effect，会被忽略
     * 为什么默认不允许递归？
     * const foo = ref([])
     * effect(()=>{
     *     foo.value.push(1)
     * })
     * 在这个副作用函数中，即会使用到 foo.value（getter 收集依赖），又会修改 foo 数组（触发依赖）。如果允许递归，会无限循环。
     */
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      if (effect.scheduler) {
        effect.scheduler()
      } else {
        effect.run()
      }
    }
  }
}
