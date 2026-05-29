import * as dotenv from 'dotenv'
import { Sequelize } from 'sequelize'

dotenv.config()

// postgres in production (k8s), sqlite for local/dev and tests. sqlite3 is a dev
// dependency, so production images don't ship it (smaller, fewer CVEs).
const dialect = process.env.DB_DIALECT || (process.env.NODE_ENV === 'production' ? 'postgres' : 'sqlite')

// Connection params come from env so nothing is baked into the build.
const sequelize = dialect === 'postgres'
    ? new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASSWORD, {
        dialect: 'postgres',
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        logging: false,
    })
    : new Sequelize({
        dialect: 'sqlite',
        storage: process.env.DB_STORAGE || ':memory:',
        logging: false,
    })

export default sequelize
