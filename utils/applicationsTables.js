let applicationsReady = null;

function ensureApplicationTables(pool) {
  if (!applicationsReady) {
    applicationsReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS driver_applications (
          id UUID PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
          payload_ciphertext TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          documents JSONB,
          admin_notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ,
          reviewed_by TEXT
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS driver_applications_status_idx ON driver_applications(status);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS driver_applications_created_at_idx ON driver_applications(created_at DESC);`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS restaurant_applications (
          id UUID PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
          payload_ciphertext TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          admin_notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at TIMESTAMPTZ,
          reviewed_by TEXT
        );
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS restaurant_applications_status_idx ON restaurant_applications(status);`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS restaurant_applications_created_at_idx ON restaurant_applications(created_at DESC);`
      );

      await pool.query(`
        CREATE TABLE IF NOT EXISTS active_drivers (
          id UUID PRIMARY KEY,
          application_id UUID UNIQUE,
          payload_ciphertext TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS active_drivers_created_at_idx ON active_drivers(created_at DESC);`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS active_restaurants (
          id UUID PRIMARY KEY,
          application_id UUID UNIQUE,
          payload_ciphertext TEXT NOT NULL,
          payload_iv TEXT NOT NULL,
          payload_tag TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS active_restaurants_created_at_idx ON active_restaurants(created_at DESC);`
      );
    })().catch((err) => {
      applicationsReady = null;
      throw err;
    });
  }
  return applicationsReady;
}

module.exports = { ensureApplicationTables };

