import * as dotenv from 'dotenv'
import { Sequelize } from 'sequelize'

dotenv.config()

const dialect = process.env.DB_DIALECT || 'sqlite'

// Same image, two backends: sqlite for local/dev and CI, postgres in kubernetes.
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
