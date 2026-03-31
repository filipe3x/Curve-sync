import React, { Component } from 'react';
import { all } from '../../services/asset';
import { total_net_value, total_rent } from '../../services/user';
import MoneyIcon from 'material-ui/svg-icons/editor/attach-money'; // Ícone de dinheiro
import CustomLink from '../common/customLink';
import CoinCard from '../coin_card';
import {Box, GridList} from 'material-ui';
import {Row, Col, Grid} from 'react-bootstrap';

class Curve extends Component {
    state = {
        assets: [],
        count: 0,
        screenWidth: window.innerWidth,
        gridListStyle: {
            // width: 800,
            // height: 450,
            //overflowY: 'auto',
        }
    };

    componentDidMount() {
      this._retrieveAssets();
      window.addEventListener('resize', this.handleResize);
    }
    
    handleResize = () => {
      this.setState({ screenWidth: window.innerWidth });
    }

    _retrieveAssets = () => {

      all({}).success(res => {
        this.setState({
          assets: res,
          count: res.count
        })
      })
    };

    render() {
      const {gridListStyle, screenWidth} = this.state;
      const numCols = Math.floor(screenWidth / 320); //  1280px/4 = 160 Adjust as needed for tile width

      return (
        <Row className="align-items-center justify-content-center">
          <h1><MoneyIcon /> Add Curve Card</h1>
          <Col xs={10}>
              <GridList cellHeight="auto" cols={numCols} style={gridListStyle}>
                    {this.state.assets.filter(asset => asset.show).map((asset, index) => (
                      <CoinCard key={index} asset={asset} />
                      ))}
              </GridList>
          </Col>
        </Row>
      );
    }

}

export default Curve;