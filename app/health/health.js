import express from 'express'
import sequelize from '../shared/database/database.js'

const healthRouter = express.Router()

// liveness: the process is up. No dependencies checked on purpose, so a flaky
// db doesn't trigger pod restarts.
healthRouter.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' })
})

// readiness: only report ready once the db actually answers
healthRouter.get('/ready', async (req, res) => {
    try {
        await sequelize.authenticate()
        res.status(200).json({ status: 'ready' })
    } catch (err) {
        res.status(503).json({ status: 'not ready' })
    }
})

export { healthRouter }
