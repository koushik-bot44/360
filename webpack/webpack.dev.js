const path = require('path');
const { merge } = require('webpack-merge')
const commonConfiguration = require('./webpack.common.js')

const infoColor = (_message) =>
{
    return `\u001b[1m\u001b[34m${_message}\u001b[39m\u001b[22m`
}

module.exports = merge(
    commonConfiguration,
    {
        output: {
            filename: '[name].[contenthash].js',
            path: path.resolve(__dirname, '../dist'),
            publicPath: "/",
        },
        mode: 'development',
        devServer:
        {
            host: '0.0.0.0',
            allowedHosts: 'all',
            port: 3000,
            // HTTPS (self-signed) so phones allow the camera + motion sensors —
            // they're blocked on plain http except on localhost. webpack-dev-server
            // auto-generates the certificate; accept the warning on the phone.
            server: 'https',
            open: true,
            // Never let the dev overlay cover the app; show build errors in the
            // terminal instead, and never for warnings.
            client: { overlay: { errors: false, warnings: false } },
            // Serve the generated app (and copied static assets) from the
            // root URL so the tour is available at http://localhost:3000/
            static: {
              directory: path.resolve(__dirname, "..", "static"),
              publicPath: "/",
              watch: true,
            },
        }
    }
)
