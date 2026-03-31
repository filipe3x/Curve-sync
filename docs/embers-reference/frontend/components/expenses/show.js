import React, { Component } from 'react';
import { connect } from 'react-redux';
import { FormGroup, ControlLabel, Row, Col } from 'react-bootstrap';
import {
    Paper,
    RaisedButton,
    Avatar
} from 'material-ui';
import { paperStyle } from '../common/styles';
import { show } from '../../services/expense';
import CategoryIcon from '../common/icons/category';

class Expense extends Component {
  state = {
    expense: {
        logo: {url: ''},
    },
  };

  componentWillMount() {
    this._retrieveExpense();
  }

  _retrieveExpense = () => {
    const { id } = this.props.params;
    show(id).success(res => {
      this.setState({
        expense: res.expense
      })
    })
  };

  render() {
    const { expense } = this.state;

    return (
        <Paper style={paperStyle} zDepth={1}>
          <Row>
            <Col sm={4}>
              <ControlLabel><h2><CategoryIcon/> &nbsp;Expense</h2></ControlLabel>
            </Col>
            <Col sm={8}>
              <RaisedButton href='#/expenses' className='pull-right' secondary={true} label='Back'/>
            </Col>
          </Row>
          <hr/>
          <FormGroup>
              <Row>
                  <Col sm={12}>
                      <Col xs={6} md={2}>
                          <Avatar src={expense.category_icon || ''} size={150} />
                      </Col>
                      <Col sm={4}>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Entity</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.entity || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Card</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.card || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Date of Expense</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.date || 'Not specified'}
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>ID</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.id || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Created at</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.created_at || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Updated at</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.updated_at || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Amount in EUR</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.amount || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Digest</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.digest || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Total Spent with this entity</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.entity_total_spent || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Category</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.category || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                          <Row>
                              <Col sm={4}>
                                  <ControlLabel>Total Spent in this Category</ControlLabel>
                              </Col>
                              <Col sm={8}>
                                    <span className="form-control-static">
                                      { expense.category_total_spent || 'Not specified' }
                                    </span>
                              </Col>
                          </Row>
                      </Col>
                  </Col>
              </Row>
              <hr/>
          </FormGroup>
        </Paper>
    )
  }
}

export default connect(state => state)(Expense)
