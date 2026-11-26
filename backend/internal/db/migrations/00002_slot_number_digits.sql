-- Minimum number of digits for slot numbers on the session page and PDF export; shorter
-- numbers are padded with leading zeros (3 → 001).

-- +goose Up
INSERT INTO settings (key, value) VALUES ('slot_number_digits', '1');

-- +goose Down
DELETE FROM settings WHERE key = 'slot_number_digits';
