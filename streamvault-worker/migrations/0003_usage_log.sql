-- Daily usage tracking for free tier monitoring
CREATE TABLE usage_log (
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER DEFAULT 0,
  PRIMARY KEY (date, metric)
);
