-- Dummy instructors for local development. See README.md (Dummy data).

INSERT INTO instructors (first_name, last_name, email) VALUES
  ('Bob', 'de Docent', 'test1@gmail.com'),
  ('Jaap', 'de Docent', 'test2@gmail.com'),
  ('Karel', 'de Docent', 'test3@gmail.com')
ON CONFLICT (email) DO NOTHING;
