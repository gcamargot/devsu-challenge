import sequelize from './shared/database/database.js'
import { usersRouter } from "./users/router.js"
import { healthRouter } from "./health/health.js"
import express from 'express'

const app = express()
const PORT = process.env.PORT || 8000

app.use(express.json())
app.use('/api/users', usersRouter)
app.use(healthRouter)

// create the table if it isn't there yet (no force: we don't want to drop data on every boot)
sequelize.sync().then(() => console.log('db is ready'))

const server = app.listen(PORT, () => {
    console.log('Server running on port', PORT)
})

// close the http server and the db pool on shutdown so rolling updates don't drop requests
const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`)
    server.close(async () => {
        await sequelize.close()
        process.exit(0)
    })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export { app, server }
