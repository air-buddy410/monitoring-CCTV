-- Peran dan basis data untuk slice MVP-0. Nilai DUMMY, hanya untuk lab.
-- Migrasi (packages/db/migrations) menolak jalan bila peran aplikasi belum ada.
-- Basis data dibuat di sini (bukan lewat POSTGRES_DB) supaya pemiliknya pantau_owner,
-- sama seperti scripts/setup-local-db.sh, sehingga migrasi boleh membuat tabel.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pantau_owner') THEN
    CREATE ROLE pantau_owner LOGIN PASSWORD 'pantau_dev_pw' CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pantau_app') THEN
    CREATE ROLE pantau_app LOGIN PASSWORD 'pantau_dev_pw' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

SELECT 'CREATE DATABASE pantau OWNER pantau_owner'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'pantau')\gexec
