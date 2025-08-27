/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  isVue2,
  defineComponent,
  onBeforeMount,
  onMounted,
  onBeforeUnmount,
  onActivated,
  shallowReactive,
  ref,
  shallowRef,
  watch,
  type ShallowRef,
  type ShallowReactive,
  type VNode,
  type SetupContext,
} from 'vue-demi';
import { ObserverItem } from '../common/ObserverItem';
import type {
  EmitFunction,
  ReactiveData,
  SlotSize,
  VirtListProps,
  VirtListReturn,
} from './type';

import { _h, _h2Slot, _hChild, getSlot, mergeStyles } from '../../utils';

const defaultProps = {
  itemGap: 0,
  fixed: false,
  buffer: 0,
  bufferTop: 0,
  bufferBottom: 0,
  scrollDistance: 0,
  horizontal: false,
  fixSelection: false,
  start: 0,
  offset: 0,
  listStyle: '',
  listClass: '',
  itemStyle: '',
  itemClass: '',
  headerClass: '',
  headerStyle: '',
  footerClass: '',
  footerStyle: '',
  stickyHeaderClass: '',
  stickyHeaderStyle: '',
  stickyFooterClass: '',
  stickyFooterStyle: '',
};

function useVirtList<T extends Record<string, any>>(
  userProps: ShallowReactive<VirtListProps<T>>,
  emitFunction?: EmitFunction<T>,
): VirtListReturn<T> {
  const props = new Proxy(userProps, {
    get(target, key) {
      return Reflect.get(target, key) ?? Reflect.get(defaultProps, key);
    },
  }) as Required<VirtListProps<T>>;

  const clientRefEl = ref<HTMLElement | null>(null);
  const listRefEl = ref<HTMLElement | null>(null);
  const headerRefEl = ref<HTMLElement | null>(null);
  const footerRefEl = ref<HTMLElement | null>(null);
  const stickyHeaderRefEl = ref<HTMLElement | null>(null);
  const stickyFooterRefEl = ref<HTMLElement | null>(null);

  const sizesMap = new Map();
  const renderKey = ref(0);
  let direction: 'forward' | 'backward' = 'backward';
  // 一个手动设置滚动的标志位，用来判断是否需要纠正滚动位置
  let fixOffset = false;
  let forceFixOffset = false;
  let abortFixOffset = false;

  let fixTaskFn: null | (() => void) = null;

  // 添加防抖相关变量和性能优化
  let resizeDebounceTimer: number | null = null;
  let scrollCorrectionTimer: number | null = null;
  let isScrolling = false;
  let rafId: number | null = null;
  
  // 缓存计算结果
  const itemSizeCache = {} as Record<string, number>;
  let lastCalcRangeParams: { offset: number; inViewBegin: number } | null = null;

  const slotSize: ShallowReactive<SlotSize> = shallowReactive({
    clientSize: 0,
    headerSize: 0,
    footerSize: 0,
    stickyHeaderSize: 0,
    stickyFooterSize: 0,
  });

  // 全局需要响应式的数据
  const reactiveData: ShallowReactive<ReactiveData> = shallowReactive({
    // 可视区域的个数，不算buffer，只和clientSize和minSize有关
    views: 0,

    // 滚动距离
    offset: 0,
    // 不包含插槽的高度
    listTotalSize: 0,
    // 虚拟占位尺寸，是从0到renderBegin的尺寸
    virtualSize: 0,
    // 可视区的起始下标
    inViewBegin: 0,
    // 可视区的结束下标
    inViewEnd: 0,

    // buffer的起始下标
    renderBegin: 0,
    // buffer的结束下标
    renderEnd: 0,

    bufferTop: 0,
    bufferBottom: 0,
  });

  function getOffset() {
    const directionKey = props.horizontal ? 'scrollLeft' : 'scrollTop';
    return clientRefEl.value ? clientRefEl.value[directionKey] : 0;
  }
  function getSlotSize() {
    return (
      slotSize.headerSize +
      slotSize.footerSize +
      slotSize.stickyHeaderSize +
      slotSize.stickyFooterSize
    );
  }
  function getTotalSize() {
    return (
      reactiveData.listTotalSize +
      slotSize.headerSize +
      slotSize.footerSize +
      slotSize.stickyHeaderSize +
      slotSize.stickyFooterSize
    );
  }
  function getItemSize(itemKey: string) {
    if (props.fixed) return props.minSize + props.itemGap;
    
    const key = String(itemKey);
    // 使用缓存提高性能
    if (key in itemSizeCache) {
      return itemSizeCache[key];
    }
    
    const size = sizesMap.get(key) ?? props.minSize + props.itemGap;
    itemSizeCache[key] = size;
    return size;
  }
  function setItemSize(itemKey: string, size: number) {
    const key = String(itemKey);
    sizesMap.set(key, size);
    // 同步更新缓存
    itemSizeCache[key] = size;
  }
  function deleteItemSize(itemKey: string) {
    const key = String(itemKey);
    sizesMap.delete(key);
    // 同步删除缓存
    delete itemSizeCache[key];
  }
  // 通过下标来获取元素位置信息
  function getItemPosByIndex(index: number) {
    if (props.fixed) {
      return {
        top: (props.minSize + props.itemGap) * index,
        current: props.minSize + props.itemGap,
        bottom: (props.minSize + props.itemGap) * (index + 1),
      };
    }

    const { itemKey } = props;
    let topReduce = slotSize.headerSize;
    for (let i = 0; i <= index - 1; i += 1) {
      const currentSize = getItemSize(props.list[i]?.[itemKey]);
      topReduce += currentSize;
    }
    const current = getItemSize(props.list[index]?.[itemKey]);
    return {
      top: topReduce,
      current,
      bottom: topReduce + current,
    };
  }

  function scrollToOffset(offset: number) {
    abortFixOffset = true;
    const directionKey = props.horizontal ? 'scrollLeft' : 'scrollTop';
    if (clientRefEl.value) clientRefEl.value[directionKey] = offset;
  }
  // expose 滚动到指定下标
  async function scrollToIndex(index: number) {
    if (index < 0) {
      return;
    }

    // 如果要去的位置大于长度，那么就直接调用去底部的方法
    if (index >= props.list.length - 1) {
      scrollToBottom();
      return;
    }

    let { top: lastOffset } = getItemPosByIndex(index);

    scrollToOffset(lastOffset);

    // 这里不适用settimeout，因为无法准确把控延迟时间，3ms有可能页面还拿不到高度。
    const fixToIndex = () => {
      const { top: offset } = getItemPosByIndex(index);
      scrollToOffset(offset);
      if (lastOffset !== offset) {
        lastOffset = offset;
        fixTaskFn = fixToIndex;
        return;
      }
      // 重置后如果不需要修正，将修正函数置空
      fixTaskFn = null;
    };
    fixTaskFn = fixToIndex;
  }
  // expose 滚动到可视区域
  async function scrollIntoView(index: number) {
    const { top: targetMin, bottom: targetMax } = getItemPosByIndex(index);
    const offsetMin = getOffset();
    const offsetMax = getOffset() + slotSize.clientSize;
    const currentSize = getItemSize(props.list[index]?.[props.itemKey]);
    if (
      targetMin < offsetMin &&
      offsetMin < targetMax &&
      currentSize < slotSize.clientSize
    ) {
      // 如果目标元素上方看不到，底部看得到，那么滚动到顶部部看得到就行了
      scrollToOffset(targetMin);
      return;
    }
    if (
      targetMin + slotSize.stickyHeaderSize < offsetMax &&
      offsetMax < targetMax + slotSize.stickyHeaderSize &&
      currentSize < slotSize.clientSize
    ) {
      // 如果目标元素上方看得到，底部看不到，那么滚动到底部看得到就行了
      scrollToOffset(
        targetMax - slotSize.clientSize + slotSize.stickyHeaderSize,
      );
      return;
    }

    // 屏幕下方
    if (targetMin + slotSize.stickyHeaderSize >= offsetMax) {
      scrollToIndex(index);
      return;
    }

    // 屏幕上方
    if (targetMax <= offsetMin) {
      scrollToIndex(index);
      return;
    }

    // 在中间就不动了
  }
  // expose 滚动到顶部，这个和去第一个元素不同
  async function scrollToTop() {
    let count = 0;
    function loopScrollToTop() {
      count += 1;
      scrollToOffset(0);
      setTimeout(() => {
        if (count > 10) {
          return;
        }
        const directionKey = props.horizontal ? 'scrollLeft' : 'scrollTop';
        // 因为纠正滚动条会有误差，所以这里需要再次纠正
        if (clientRefEl?.value?.[directionKey] !== 0) {
          loopScrollToTop();
        }
      }, 3);
    }
    loopScrollToTop();
  }
  // expose 滚动到底部
  async function scrollToBottom() {
    let count = 0;
    function loopScrollToBottom() {
      count += 1;
      scrollToOffset(getTotalSize());
      setTimeout(() => {
        // 做一次拦截，防止异常导致的死循环
        if (count > 10) {
          return;
        }
        // 修复底部误差，因为缩放屏幕的时候，获取的尺寸都是小数，精度会有问题，这里把误差调整为2px
        if (
          Math.abs(
            Math.round(reactiveData.offset + slotSize.clientSize) -
              Math.round(getTotalSize()),
          ) > 2
        ) {
          loopScrollToBottom();
        }
      }, 3);
    }
    loopScrollToBottom();
  }

  // 修复vue2-diff的bug导致的selection问题
  function fixSelection() {
    const selection = window.getSelection();
    if (selection) {
      const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
      if (
        anchorNode &&
        anchorOffset !== null &&
        focusNode !== null &&
        focusOffset
      ) {
        requestAnimationFrame(() => {
          if (anchorOffset < focusOffset) {
            selection.setBaseAndExtent(
              anchorNode,
              anchorOffset,
              focusNode,
              focusOffset,
            );
          } else {
            selection.setBaseAndExtent(
              focusNode,
              focusOffset,
              anchorNode,
              anchorOffset,
            );
          }
        });
      }
    }
  }

  function updateRange(start: number) {
    // 修复vue2-diff的bug
    if (isVue2 && props.fixSelection && direction === 'backward') {
      fixSelection();
    }

    // 添加边界检查，确保start在有效范围内
    const listLength = props.list?.length ?? 0;
    if (listLength === 0) {
      reactiveData.inViewBegin = 0;
      reactiveData.inViewEnd = 0;
      emitFunction?.rangeUpdate?.(0, 0);
      return;
    }
    
    const safeStart = Math.max(0, Math.min(start, listLength - 1));
    
    if (safeStart < reactiveData.inViewBegin) {
      // 向上滚动需要修正
      fixOffset = true;
    }

    reactiveData.inViewBegin = safeStart;
    reactiveData.inViewEnd = Math.min(
      safeStart + reactiveData.views,
      listLength - 1,
    );

    // expose
    emitFunction?.rangeUpdate?.(
      reactiveData.inViewBegin,
      reactiveData.inViewEnd,
    );
  }

  function calcRange() {
    const { views, offset, inViewBegin } = reactiveData;
    const { itemKey } = props;
    const listLength = props.list?.length ?? 0;

    // 空列表处理
    if (listLength === 0) {
      updateRange(0);
      return;
    }

    const offsetWithNoHeader = offset - slotSize.headerSize;
    let start = inViewBegin;
    let offsetReduce = getVirtualSize2beginInView();

    // 当有顶部插槽的时候，快速滚动到顶部，则需要判断，并直接修正
    if (offsetWithNoHeader < 0) {
      updateRange(0);
      return;
    }

    // 缓存优化：如果参数没有显著变化，跳过计算
    if (lastCalcRangeParams && 
        Math.abs(lastCalcRangeParams.offset - offset) < 1 && 
        lastCalcRangeParams.inViewBegin === inViewBegin) {
      return;
    }
    lastCalcRangeParams = { offset, inViewBegin };

    // 添加稳定性检查，避免频繁的范围变化
    const tolerance = 2; // 增加容差到2px
    
    if (direction === 'forward') {
      // 1. 没发生变化或变化很小
      if (offsetWithNoHeader >= offsetReduce - tolerance) {
        return;
      }
      // 优化：限制循环范围，避免过度计算
      const maxIterations = Math.min(start, 50);
      for (let i = start - 1, iterations = 0; i >= 0 && iterations < maxIterations; i -= 1, iterations += 1) {
        const currentSize = getItemSize(props.list[i]?.[itemKey]);
        offsetReduce -= currentSize;
        if (
          offsetReduce <= offsetWithNoHeader &&
          offsetWithNoHeader < offsetReduce + currentSize
        ) {
          start = i;
          break;
        }
      }
    }

    if (direction === 'backward') {
      if (offsetWithNoHeader <= offsetReduce + tolerance) {
        return;
      }
      // 优化：限制循环范围，避免过度计算
      const maxIterations = Math.min(listLength - start, 50);
      for (let i = start, iterations = 0; i <= listLength - 1 && iterations < maxIterations; i += 1, iterations += 1) {
        const currentSize = getItemSize(props.list[i]?.[itemKey]);

        if (
          offsetReduce <= offsetWithNoHeader &&
          offsetWithNoHeader < offsetReduce + currentSize
        ) {
          start = i;
          break;
        }
        offsetReduce += currentSize;
      }

      // 向下滚动不需要修正
      fixOffset = false;
    }

    // 节流 - 只有当变化足够大时才更新，并确保start在有效范围内
    const safeStart = Math.max(0, Math.min(start, listLength - 1));
    if (Math.abs(safeStart - reactiveData.inViewBegin) >= 1) {
      updateRange(safeStart);
    }
  }

  function judgePosition() {
    // 使用2px作为误差范围
    const threshold = Math.max(props.scrollDistance, 2);

    if (direction === 'forward') {
      if (reactiveData.offset - threshold <= 0) {
        // console.log('[VirtList] 到达顶部');
        emitFunction?.toTop?.(props.list[0]);
      }
    } else if (direction === 'backward') {
      // 使用一个 Math.round 来解决小数点的误差问题
      const scrollSize = Math.round(reactiveData.offset + slotSize.clientSize);
      const distanceToBottom = Math.round(getTotalSize() - scrollSize);
      if (distanceToBottom <= threshold) {
        // console.log('[VirtList] 到达底部');
        emitFunction?.toBottom?.(props.list[props.list.length - 1]);
      }
    }
  }

  function onScroll(evt: Event) {
    emitFunction?.scroll?.(evt);

    const offset = getOffset();

    if (offset === reactiveData.offset) return;
    
    // 设置滚动状态
    isScrolling = true;
    
    // 清除之前的滚动纠正定时器和RAF
    if (scrollCorrectionTimer) {
      clearTimeout(scrollCorrectionTimer);
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
    }
    
    direction = offset < reactiveData.offset ? 'forward' : 'backward';
    reactiveData.offset = offset;

    // 使用requestAnimationFrame来优化性能，避免重复调用
    rafId = requestAnimationFrame(() => {
      rafId = null;
      calcRange();
      judgePosition();
    });
    
    // 滚动结束后重置状态
    scrollCorrectionTimer = window.setTimeout(() => {
      isScrolling = false;
    }, 150); // 增加到150ms，减少频繁的状态切换
  }

  function calcViews() {
    // 不算buffer的个数
    const newViews =
      Math.ceil(slotSize.clientSize / (props.minSize + props.itemGap)) + 1;
    reactiveData.views = newViews;
  }

  function onClientResize() {
    // 可视区域尺寸变化 => 1. 更新可视区域个数 2. 可视区域个数变化后需要及时更新记录尺寸
    calcViews();
    updateRange(reactiveData.inViewBegin);
  }

  function calcListTotalSize() {
    if (props.fixed) {
      reactiveData.listTotalSize =
        (props.minSize + props.itemGap) * props.list.length;
      return;
    }
    const { itemKey } = props;
    let re = 0;
    for (let i = 0; i <= props.list.length - 1; i += 1) {
      re += getItemSize(props.list[i]?.[itemKey]);
    }
    reactiveData.listTotalSize = re;
  }

  function reset() {
    reactiveData.offset = 0;
    reactiveData.listTotalSize = 0;
    reactiveData.virtualSize = 0;

    reactiveData.inViewBegin = 0;
    reactiveData.inViewEnd = 0;

    reactiveData.renderBegin = 0;
    reactiveData.renderEnd = 0;
    
    // 清理所有缓存
    sizesMap.clear();
    Object.keys(itemSizeCache).forEach(key => {
      delete itemSizeCache[key];
    });
    lastCalcRangeParams = null;

    // [require] 当列表为空时，需要重新渲染，否则会残留渲染
    forceUpdate();
  }
  // expose only
  function deletedList2Top(deletedList: T[]) {
    calcListTotalSize();
    let deletedListSize = 0;
    deletedList.forEach((item) => {
      deletedListSize += getItemSize(item[props.itemKey]);
    });
    updateTotalVirtualSize();
    scrollToOffset(reactiveData.offset - deletedListSize);
    calcRange();
  }
  // expose only
  function addedList2Top(addedList: T[]) {
    calcListTotalSize();
    let addedListSize = 0;
    addedList.forEach((item) => {
      addedListSize += getItemSize(item[props.itemKey]);
    });
    updateTotalVirtualSize();
    scrollToOffset(reactiveData.offset + addedListSize);
    forceFixOffset = true;
    abortFixOffset = false;
    calcRange();
  }

  function forceUpdate() {
    renderKey.value += 1;
  }

  let resizeObserver: ResizeObserver | undefined = undefined;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      // 清除之前的防抖定时器
      if (resizeDebounceTimer) {
        clearTimeout(resizeDebounceTimer);
      }
      
      // 使用防抖来减少频繁的resize处理
       resizeDebounceTimer = window.setTimeout(() => {
        let diff = 0;
        let hasSignificantChange = false;
        
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const id = target?.dataset?.id;
          if (!id) continue;
          
          const oldSize = getItemSize(id);

          let newSize = 0;
          // 兼容性处理，详情：https://developer.mozilla.org/zh-CN/docs/Web/API/ResizeObserver
          // ios中没有borderBoxSize，只有contentRect
          if (entry.borderBoxSize) {
            // Firefox implements `borderBoxSize` as a single content rect, rather than an array
            const borderBoxSize = Array.isArray(entry.borderBoxSize)
              ? entry.borderBoxSize[0]
              : entry.borderBoxSize;
            newSize = props.horizontal
              ? borderBoxSize.inlineSize
              : borderBoxSize.blockSize;
          } else {
            newSize = props.horizontal
              ? entry.contentRect.width
              : entry.contentRect.height;
          }

          // 处理特殊元素
          if (id === 'client') {
            if (Math.abs(slotSize.clientSize - newSize) > 1) {
              slotSize.clientSize = newSize;
              onClientResize();
              hasSignificantChange = true;
            }
          } else if (id === 'header') {
            if (Math.abs(slotSize.headerSize - newSize) > 0.5) {
              slotSize.headerSize = newSize;
              hasSignificantChange = true;
            }
          } else if (id === 'footer') {
            if (Math.abs(slotSize.footerSize - newSize) > 0.5) {
              slotSize.footerSize = newSize;
              hasSignificantChange = true;
            }
          } else if (id === 'stickyHeader') {
            if (Math.abs(slotSize.stickyHeaderSize - newSize) > 0.5) {
              slotSize.stickyHeaderSize = newSize;
              hasSignificantChange = true;
            }
          } else if (id === 'stickyFooter') {
            if (Math.abs(slotSize.stickyFooterSize - newSize) > 0.5) {
              slotSize.stickyFooterSize = newSize;
              hasSignificantChange = true;
            }
          } else if (Math.abs(oldSize - newSize) > 1) { // 增加阈值到1px避免微小变化
            setItemSize(id, newSize);
            diff += newSize - oldSize;
            emitFunction?.itemResize?.(id, newSize);
            hasSignificantChange = true;
          }
        }
        
        if (Math.abs(diff) > 1) { // 只有当差异足够大时才更新
          reactiveData.listTotalSize += diff;
        }

        // 如果有需要修正的方法进行修正
        if (fixTaskFn) {
          fixTaskFn();
        }
        
        // 向上滚动纠正误差 - 当没有顶部buffer的时候是需要的
        // 添加滚动状态检查，避免在滚动过程中进行纠正
        if ((fixOffset || forceFixOffset) && Math.abs(diff) > 1 && !abortFixOffset && !isScrolling && hasSignificantChange) {
          fixOffset = false;
          forceFixOffset = false;
          scrollToOffset(reactiveData.offset + diff);
        }
        abortFixOffset = false;
        
        // 清理缓存以确保下次计算的准确性
        if (hasSignificantChange) {
          lastCalcRangeParams = null;
        }
      }, 16); // 使用16ms防抖，约等于一帧的时间
    });
  }

  const updateTotalVirtualSize = () => {
    let offset = 0;
    const currentFirst = reactiveData.renderBegin;
    for (let i = 0; i < currentFirst; i++) {
      offset += getItemSize(props.list[i]?.[props.itemKey]);
    }
    reactiveData.virtualSize = offset;
  };

  onBeforeMount(() => {
    if (props.bufferTop) {
      reactiveData.bufferTop = props.bufferTop;
    } else {
      reactiveData.bufferTop = props.buffer;
    }

    if (props.bufferBottom) {
      reactiveData.bufferBottom = props.bufferBottom;
    } else {
      reactiveData.bufferBottom = props.buffer;
    }
  });

  onMounted(() => {
    if (clientRefEl.value) {
      clientRefEl.value.addEventListener('scroll', onScroll);

      resizeObserver?.observe(clientRefEl.value);
    }

    if (stickyHeaderRefEl.value) {
      resizeObserver?.observe(stickyHeaderRefEl.value);
    }
    if (stickyFooterRefEl.value) {
      resizeObserver?.observe(stickyFooterRefEl.value);
    }
    if (headerRefEl.value) {
      resizeObserver?.observe(headerRefEl.value);
    }
    if (footerRefEl.value) {
      resizeObserver?.observe(footerRefEl.value);
    }

    if (props.start) {
      scrollToIndex(props.start);
    } else if (props.offset) {
      scrollToOffset(props.offset);
    }
  });

  // 处理 keep-alive 激活时的问题
  onActivated(() => {
    // 清理缓存，确保重新计算
    lastCalcRangeParams = null;
    
    // 延迟执行，确保DOM已经完全渲染
    setTimeout(() => {
      // 强制更新可视区域计算
      forceUpdate();
      
      // 如果有滚动位置，重新设置
      if (clientRefEl.value) {
        const currentScrollTop = clientRefEl.value.scrollTop;
        if (currentScrollTop > 0) {
           // 触发滚动事件重新计算可视区域
           const mockEvent = new Event('scroll');
           onScroll(mockEvent);
         } else {
           // 如果在顶部，确保正确显示第一屏内容
           updateRange(0);
         }
      }
    }, 0);
  });

  onBeforeUnmount(() => {
    // 清理所有定时器和RAF
    if (resizeDebounceTimer) {
      clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = null;
    }
    if (scrollCorrectionTimer) {
      clearTimeout(scrollCorrectionTimer);
      scrollCorrectionTimer = null;
    }
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    
    // 清理事件监听器
    if (clientRefEl.value) {
      clientRefEl.value.removeEventListener('scroll', onScroll);
      resizeObserver?.unobserve(clientRefEl.value);
      slotSize.clientSize = 0;
    }

    // 清理所有ResizeObserver
    if (stickyHeaderRefEl.value) {
      resizeObserver?.unobserve(stickyHeaderRefEl.value);
      slotSize.stickyHeaderSize = 0;
    }
    if (stickyFooterRefEl.value) {
      resizeObserver?.unobserve(stickyFooterRefEl.value);
      slotSize.stickyFooterSize = 0;
    }
    if (headerRefEl.value) {
      resizeObserver?.unobserve(headerRefEl.value);
      slotSize.headerSize = 0;
    }
    if (footerRefEl.value) {
      resizeObserver?.unobserve(footerRefEl.value);
      slotSize.footerSize = 0;
    }
    
    // 断开ResizeObserver连接
    resizeObserver?.disconnect();
    
    // 清理缓存和状态
    sizesMap.clear();
    Object.keys(itemSizeCache).forEach(key => {
      delete itemSizeCache[key];
    });
    lastCalcRangeParams = null;
    fixTaskFn = null;
    
    // 重置状态标志
    isScrolling = false;
    fixOffset = false;
    forceFixOffset = false;
    abortFixOffset = false;
  });

  function getVirtualSize2beginInView() {
    return (
      reactiveData.virtualSize +
      getRangeSize(reactiveData.renderBegin, reactiveData.inViewBegin)
    );
  }

  function getRangeSize(range1: number, range2: number) {
    const start = Math.min(range1, range2);
    const end = Math.max(range1, range2);
    let re = 0;
    for (let i = start; i < end; i += 1) {
      re += getItemSize(props.list[i]?.[props.itemKey]);
    }
    return re;
  }

  function getReactiveData() {
    return reactiveData;
  }

  const renderList: ShallowRef<T[]> = shallowRef([]);

  function manualRender(_newRenderBegin: number, _newRenderEnd: number) {
    // 旧的渲染起始
    const _oldRenderBegin = reactiveData.renderBegin;

    // update render begin
    reactiveData.renderBegin = _newRenderBegin;
    // update render end
    reactiveData.renderEnd = _newRenderEnd;
    // update virtualSize, diff range size
    if (_newRenderBegin > _oldRenderBegin) {
      reactiveData.virtualSize += getRangeSize(
        _newRenderBegin,
        _oldRenderBegin,
      );
    } else {
      reactiveData.virtualSize -= getRangeSize(
        _newRenderBegin,
        _oldRenderBegin,
      );
    }
    // update render list - 添加边界检查防止重复渲染
    const safeRenderBegin = Math.max(0, Math.min(_newRenderBegin, props.list.length - 1));
    const safeRenderEnd = Math.max(safeRenderBegin, Math.min(_newRenderEnd, props.list.length - 1));
    
    renderList.value = props.list.slice(
      safeRenderBegin,
      safeRenderEnd + 1,
    );
    // update size
    updateTotalVirtualSize();
  }

  watch(
    // 这里为什么用 renderKey 代替监听 props.list
    // 因为props.list会导致v-for时deepArray导致大量的性能浪费
    () => [reactiveData.inViewBegin, reactiveData.inViewEnd, renderKey.value],
    (newVal, oldVal) => {
      if (newVal && oldVal) {
        // console.log('watch', newVal, oldVal);
        const [_newInViewBegin] = newVal;

        // 旧的渲染起始
        const _oldRenderBegin = reactiveData.renderBegin;

        // 新的渲染起始
        let _newRenderBegin = _newInViewBegin;
        // 新的渲染结束
        let _newRenderEnd = reactiveData.inViewEnd;

        // 计算buffer
        _newRenderBegin = Math.max(0, _newRenderBegin - reactiveData.bufferTop);
        _newRenderEnd = Math.min(
          _newRenderEnd + reactiveData.bufferBottom,
          props.list.length - 1 > 0 ? props.list.length - 1 : 0,
        );

        // 控制层渲染，等于说要覆盖掉buffer
        if (props?.renderControl) {
          const { begin, end } = props.renderControl(
            _newInViewBegin,
            reactiveData.inViewEnd,
          );
          _newRenderBegin = begin;
          _newRenderEnd = end;
        }

        // update render begin
        reactiveData.renderBegin = _newRenderBegin;
        // update render end
        reactiveData.renderEnd = _newRenderEnd;
        // update virtualSize, diff range size
        if (_newRenderBegin > _oldRenderBegin) {
          reactiveData.virtualSize += getRangeSize(
            _newRenderBegin,
            _oldRenderBegin,
          );
        } else {
          reactiveData.virtualSize -= getRangeSize(
            _newRenderBegin,
            _oldRenderBegin,
          );
        }
        // update render list - 添加边界检查防止重复渲染
        const safeRenderBegin = Math.max(0, Math.min(reactiveData.renderBegin, props.list.length - 1));
        const safeRenderEnd = Math.max(safeRenderBegin, Math.min(reactiveData.renderEnd, props.list.length - 1));
        
        renderList.value = props.list.slice(
          safeRenderBegin,
          safeRenderEnd + 1,
        );
      }
    },
    {
      immediate: true,
    },
  );

  watch(
    () => props.list.length,
    () => {
      // 如果数据为空，那么就重置
      if (props.list.length <= 0) {
        reset();
        return;
      }

      // [require] 因为list长度变化，所以总高度有变化
      calcListTotalSize();
      // [require] 因为list长度变化，所以重新计算起始结束位置
      updateRange(reactiveData.inViewBegin);
      // [require] 如果顶部列表数据发生变更需要更正顶部高度
      updateTotalVirtualSize();
      // [require] 列表长度切内容发生变化，如果起始位置没变，则需要强制更新一下页面
      forceUpdate();
    },
    {
      immediate: true,
    },
  );

  return {
    props,

    renderList,

    clientRefEl,
    listRefEl,
    headerRefEl,
    footerRefEl,
    stickyHeaderRefEl,
    stickyFooterRefEl,

    reactiveData,
    slotSize,
    sizesMap,

    resizeObserver,

    getReactiveData,
    getOffset,
    getSlotSize,
    reset,
    scrollToIndex,
    manualRender,
    scrollIntoView,
    scrollToTop,
    scrollToBottom,
    scrollToOffset,
    getItemSize,
    deleteItemSize,
    // expose only
    deletedList2Top,
    addedList2Top,
    getItemPosByIndex,
    forceUpdate,
  };
}
const VirtList = defineComponent({
  name: 'VirtList',
  emits: {
    scroll: (e: Event) => e,
    toTop: (firstItem: any) => firstItem,
    toBottom: (lastItem: any) => lastItem,
    itemResize: (id: string, newSize: number) => true,
    rangeUpdate: (inViewBegin: number, inViewEnd: number) => true,
  },
  props: {
    list: {
      type: Array<any>,
      default: () => [],
    },
    // 数据key
    itemKey: {
      type: [String, Number],
      required: true,
    },
    // 最小尺寸
    minSize: {
      type: Number,
      default: 20,
      required: true,
    },
    itemGap: {
      type: Number,
      default: 0,
    },
    renderControl: {
      type: Function,
      default: undefined,
    },
    fixed: {
      type: Boolean,
      default: false,
    },
    buffer: {
      type: Number,
      default: 0,
    },
    bufferTop: {
      type: Number,
      default: 0,
    },
    bufferBottom: {
      type: Number,
      default: 0,
    },
    // 滚动距离阈值
    scrollDistance: {
      type: Number,
      default: 0,
    },
    // 是否为水平移动
    horizontal: {
      type: Boolean,
      default: false,
    },
    // 起始下标
    start: {
      type: Number,
      default: 0,
    },
    // 起始偏移量
    offset: {
      type: Number,
      default: 0,
    },
    listStyle: {
      type: [String, Array, Object],
      default: '',
    },
    listClass: {
      type: [String, Array, Object],
      default: '',
    },
    itemStyle: {
      type: [String, Array, Object, Function],
      default: '',
    },
    itemClass: {
      type: [String, Array, Object, Function],
      default: '',
    },
    headerClass: {
      type: [String, Array, Object],
      default: '',
    },
    headerStyle: {
      type: [String, Array, Object],
      default: '',
    },
    footerClass: {
      type: [String, Array, Object],
      default: '',
    },
    footerStyle: {
      type: [String, Array, Object],
      default: '',
    },
    stickyHeaderClass: {
      type: [String, Array, Object],
      default: '',
    },
    stickyHeaderStyle: {
      type: [String, Array, Object],
      default: '',
    },
    stickyFooterClass: {
      type: [String, Array, Object],
      default: '',
    },
    stickyFooterStyle: {
      type: [String, Array, Object],
      default: '',
    },
  },
  setup(props: any, context: SetupContext) {
    const emitFunction = {
      scroll: (e: Event) => {
        context.emit('scroll', e);
      },
      toTop: (firstItem: any) => {
        context.emit('toTop', firstItem);
      },
      toBottom: (lastItem: any) => {
        context.emit('toBottom', lastItem);
      },
      itemResize: (id: string, newSize: number) => {
        context.emit('itemResize', id, newSize);
      },
      rangeUpdate: (inViewBegin: number, inViewEnd: number) => {
        context.emit('rangeUpdate', inViewBegin, inViewEnd);
      },
    };

    return useVirtList(props, emitFunction);
  },
  render() {
    const { renderList, reactiveData, resizeObserver } = this;
    const {
      itemGap,
      itemKey,
      horizontal,
      listStyle,
      listClass,
      itemStyle,
      itemClass,
      headerClass,
      headerStyle,
      footerClass,
      footerStyle,
      stickyHeaderClass,
      stickyHeaderStyle,
      stickyFooterClass,
      stickyFooterStyle,
    } = this.props;

    const renderStickyHeaderSlot = (): VNode | null =>
      getSlot(this, 'stickyHeader')
        ? _h(
            'div',
            {
              key: 'slot-sticky-header',
              class: stickyHeaderClass,
              style: mergeStyles(
                'position: sticky; z-index: 10;',
                horizontal ? 'left: 0' : 'top: 0;',
                stickyHeaderStyle,
              ),
              ref: 'stickyHeaderRefEl',
              attrs: {
                'data-id': 'stickyHeader',
              },
            },
            [getSlot(this, 'stickyHeader')?.() as any],
          )
        : null;

    const renderStickyFooterSlot = (): VNode | null =>
      getSlot(this, 'stickyFooter')
        ? _h(
            'div',
            {
              key: 'slot-sticky-footer',
              class: stickyFooterClass,
              style: mergeStyles(
                'position: sticky; z-index: 10;',
                horizontal ? 'right: 0' : 'bottom: 0;',
                stickyFooterStyle,
              ),
              ref: 'stickyFooterRefEl',
              attrs: {
                'data-id': 'stickyFooter',
              },
            },
            [getSlot(this, 'stickyFooter')?.() as any],
          )
        : null;

    const renderHeaderSlot = (): VNode | null =>
      getSlot(this, 'header')
        ? _h(
            'div',
            {
              key: 'slot-header',
              class: headerClass,
              style: headerStyle,
              ref: 'headerRefEl',
              attrs: { 'data-id': 'header' },
            },
            [getSlot(this, 'header')?.() as any],
          )
        : null;

    const renderFooterSlot = (): VNode | null =>
      getSlot(this, 'footer')
        ? _h(
            'div',
            {
              key: 'slot-footer',
              class: footerClass,
              style: footerStyle,
              ref: 'footerRefEl',
              attrs: {
                'data-id': 'footer',
              },
            },
            [getSlot(this, 'footer')?.() as any],
          )
        : null;

    const { listTotalSize, virtualSize, renderBegin } = reactiveData;

    const renderMainList = (): VNode | null => {
      const mainList = [];
      for (let index = 0; index < renderList.length; index += 1) {
        const currentItem = renderList[index];
        // 确保key的唯一性，使用renderBegin + index作为key
        const uniqueKey = `${currentItem[itemKey]}-${renderBegin + index}`;
        mainList.push(
          _hChild(
            ObserverItem,
            {
              key: uniqueKey,
              class:
                typeof itemClass === 'function'
                  ? itemClass(currentItem, index)
                  : itemClass,
              style: mergeStyles(
                itemGap > 0 ? `padding: ${itemGap / 2}px 0;` : '',
                typeof itemStyle === 'function'
                  ? itemStyle(currentItem, index)
                  : itemStyle,
              ),
              attrs: {
                id: currentItem[itemKey],
                resizeObserver: resizeObserver,
              },
            },
            getSlot(this, 'default')?.({ 
              itemData: currentItem,
              index: renderBegin + index,
            }) || null,
          ),
        );
      }

      if (mainList.length === 0 && getSlot(this, 'empty')) {
        const height = this.slotSize.clientSize - this.getSlotSize();
        mainList.push(
          _h(
            'div',
            {
              key: `slot-empty-${height}`,
              style: `height: ${height}px`,
            },
            [getSlot(this, 'empty')?.() as any],
          ),
        );
      }

      const dynamicListStyle = horizontal
        ? `will-change: width; min-width: ${listTotalSize}px; display: flex; ${listStyle}`
        : `will-change: height; min-height: ${listTotalSize}px; ${listStyle}`;
      const virtualStyle = horizontal
        ? `width: ${virtualSize}px; will-change: width;`
        : `height: ${virtualSize}px; will-change: height;`;

      return _h(
        'div',
        {
          ref: 'listRefEl',
          class: listClass,
          style: dynamicListStyle,
        },
        [
          _h('div', {
            style: virtualStyle,
          }),
          mainList,
        ],
      );
    };

    // const renderVirtualScrollbar = () => {
    //   return <div style={`float: left; height: ${listTotalSize}px`}></div>; // 虚拟滚动条
    // };

    return _h(
      'div',
      {
        ref: 'clientRefEl',
        class: 'virt-list__client',
        // 如果要自动撑开高度，不要虚拟，修改这里的样式即可
        style: `width: 100%; height: 100%; overflow: auto;`,
        attrs: {
          'data-id': 'client',
        },
      },
      [
        renderStickyHeaderSlot(),
        renderHeaderSlot(),
        renderMainList(),
        renderFooterSlot(),
        renderStickyFooterSlot(),
      ],
    );
  },
});

export { VirtList, useVirtList };
