-- Dummy disciplines for local development. See README.md (Dummy data).

INSERT INTO disciplines (name) VALUES
  ('Groot Kaliber Geweer'),
  ('Groot Kaliber Pistool'),
  ('Groot Kaliber Revolver'),
  ('Klein Kaliber Geweer'),
  ('Klein Kaliber Pistool'),
  ('Klein Kaliber Revolver')
ON CONFLICT (name) DO NOTHING;
