/**
 * 到站播报的判据（M31-03；M65-01 从 cockpit App.tsx 抽出并上提，两端共用）。
 *
 * 「已到达」这个报告式开头是**判据的一部分**（`subgraphs/itinerary.ts` 的 `ARRIVE_PATTERNS`）：
 * 改了这里就要同步改那条正则，否则这句话会掉进规划链路——跑一分钟、回一句不相干的，
 * 而车已经开到下一站了。两端只能有一份文案。
 *
 * 两道闸，都是为了别把车主的对话冲掉：
 *  - 按站名去重：位置源只在越过段尾那一帧给 `arrivedStopName`，但轮询/重渲染可能让同一帧再流一次；
 *  - 在飞防叠：演示倍速下两站之间只有十几秒，上一句还没回完就发下一句，会话里会堆起两轮互相打断的播报。
 *    宁可少播一站。
 */

export function arrivalNote(stop: string, next: string | undefined): string {
  return next ? `已到达${stop}，下一站${next}` : `已到达${stop}，今天的行程走完了`;
}

export interface ArrivalProgress {
  arrivedStopName?: string;
  nextStopName?: string;
}

export interface ArrivalAnnouncer {
  /** 喂进每一帧的跟车进度；只在越过段尾那一帧、且上一句已回完时发。 */
  onProgress(p: ArrivalProgress): void;
  /** 换一次导航（换天 / 重新出发）时重置去重。 */
  reset(): void;
}

export function createArrivalAnnouncer(send: (note: string) => Promise<void>): ArrivalAnnouncer {
  let announced: string | null = null;
  let inFlight = false;
  return {
    onProgress(p) {
      const stop = p.arrivedStopName;
      if (!stop) return;
      if (announced === stop || inFlight) return;
      announced = stop;
      inFlight = true;
      void send(arrivalNote(stop, p.nextStopName)).finally(() => {
        inFlight = false;
      });
    },
    reset() {
      announced = null;
    },
  };
}
