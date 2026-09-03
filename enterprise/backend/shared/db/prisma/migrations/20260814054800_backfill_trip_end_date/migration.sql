-- 回填结束日（M13-11）。
--
-- `end_date` 是派生列（出发日 + 天数 - 1），新写入由仓储算好，
-- 但存量行没有——不回填的话它们在"临近排序"里会被当成没有日期的一档，
-- 而它们恰恰是最可能正在进行中的那些。
UPDATE trip_plans
SET end_date = to_char(
      to_date(start_date, 'YYYY-MM-DD') + make_interval(days => GREATEST(days, 1) - 1),
      'YYYY-MM-DD')
WHERE start_date IS NOT NULL AND end_date IS NULL;
