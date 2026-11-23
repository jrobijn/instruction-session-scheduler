-- Dummy students for local development. See README.md (Dummy data).

INSERT INTO students (first_name, last_name, email) VALUES
  ('Andre', 'de Student', 'test17@gmail.com'),
  ('Emiel', 'de Student', 'test19@gmail.com'),
  ('Fleur', 'de Student', 'test21@gmail.com'),
  ('Jan', 'de Student', 'test4@gmail.com'),
  ('Jonathan', 'de Student', 'test8@gmail.com'),
  ('Lisanne', 'de Student', 'test11@gmail.com'),
  ('Maaike', 'de Student', 'test7@gmail.com'),
  ('Manon', 'de Student', 'test12@gmail.com'),
  ('Marco', 'de Student', 'test9@gmail.com'),
  ('Mark', 'de Student', 'test6@gmail.com'),
  ('Michel', 'de Student', 'test16@gmail.com'),
  ('Nick', 'de Student', 'test18@gmail.com'),
  ('Reinier', 'de Student', 'test15@gmail.com'),
  ('Remco', 'de Student', 'test10@gmail.com'),
  ('Sander', 'de Student', 'test5@gmail.com'),
  ('Sandra', 'de Student', 'test20@gmail.com'),
  ('Tessa', 'de Student', 'test13@gmail.com'),
  ('Wopke', 'de Student', 'test14@gmail.com')
ON CONFLICT (email) DO NOTHING;
