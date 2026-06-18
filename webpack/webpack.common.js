const CopyWebpackPlugin = require('copy-webpack-plugin')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const MiniCSSExtractPlugin = require('mini-css-extract-plugin')
const BundleTracker = require("webpack-bundle-tracker");
const _template = require('lodash.template');
const fs = require('fs');
const path = require('path')
const webpack = require('webpack');
const dotenv = require('dotenv');

// Call dotenv and it will return an Object with a parsed key.
// Resilient: the app runs without a .env file (env vars are optional).
const env = dotenv.config().parsed || {};

// Reduce it to a nice object
const envKeys = Object.keys(env).reduce((prev, next) => {
  prev[`process.env.${next}`] = JSON.stringify(env[next]);
  return prev;
}, {});

// Always define the keys the app reads, so `process.env.X` never throws
// when no .env is present.
envKeys['process.env.GOOGLE_MAPS_API_KEY'] =
  envKeys['process.env.GOOGLE_MAPS_API_KEY'] || JSON.stringify('');

module.exports = {
    entry: {
        main: path.resolve(__dirname, '../src/index.js'),
        builder: path.resolve(__dirname, '../src/builder.js'),
    },
    output:
    {
        filename: '[name].[contenthash].js',
        path: path.resolve(__dirname, '../../static/webpack_bundles')
    },
    devtool: 'source-map',
    plugins:
    [
        new CopyWebpackPlugin({
            patterns: [
                { from: path.resolve(__dirname, '../static') }
            ]
        }),
        new HtmlWebpackPlugin({
            template: path.resolve(__dirname, '../src/index.html'),
            filename: 'index.html',
            chunks: ['main'],
            inject: 'body',
        }),
        new HtmlWebpackPlugin({
            template: path.resolve(__dirname, '../src/builder.html'),
            filename: 'builder.html',
            chunks: ['builder'],
            inject: 'body',
        }),
        new MiniCSSExtractPlugin({
          filename: 'styles/[name].[contenthash].css',
          chunkFilename: 'styles/[id].[contenthash].css',
        }),
        new BundleTracker({ path: __dirname, filename: "webpack-stats.json" }),
        new webpack.DefinePlugin(envKeys)
    ],
    module:
    {
        rules:
        [
            // HTML
            {
                test: /\.(html)$/,
                use: [
                    {
                        loader: 'html-loader',
                        // Leave root-absolute asset URLs (/favicon.ico, /site.webmanifest,
                        // etc.) untouched — they are served from the static directory at
                        // runtime rather than bundled.
                        options: { sources: false },
                    },
                ],
            },

            // JS
            {
                test: /\.js$/,
                exclude: /node_modules/,
                use:
                [
                    'babel-loader'
                ]
            },

            // CSS
            {
                test: /\.css$/,
                use:
                [
                    MiniCSSExtractPlugin.loader,
                    'css-loader',
                    'postcss-loader' 
                ]
            },

            // Images
            {
                test: /\.(jpg|png|gif|svg)$/,
                use:
                [
                    {
                        loader: 'file-loader',
                        options:
                        {
                            outputPath: 'assets/images/'
                        }
                    }
                ]
            },
            
            // Shaders
            {
                test: /\.glsl$/,
                use: 'raw-loader',
            },

            // Fonts
            {
                test: /\.(ttf|eot|woff|woff2)$/,
                use:
                [
                    {
                        loader: 'file-loader',
                        options:
                        {
                            outputPath: 'assets/fonts/'
                        }
                    }
                ]
            }
        ]
    }
}
